const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

// Accepts host:port, a bare hostname, or a full URL (https://www.google.com/page) and returns clean host:port entries.
function parseTargets(list) {
  const out = [];
  for (let raw of list.split(',')) {
    raw = raw.trim();
    if (!raw) continue;
    const m = raw.match(/^(?:(https?):\/\/)?([^\/:?#\s]+)(?::(\d+))?(?:[\/?#].*)?$/i);
    if (!m) { console.warn(`[config] Ignoring invalid target "${raw}". Use host:port, for example www.google.com:443`); continue; }
    const port = m[3] || (m[1] && m[1].toLowerCase() === 'http' ? '80' : '443');
    const t = `${m[2]}:${port}`;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const env = process.env;
const cfg = {
  targets: parseTargets(env.TARGETS || '1.1.1.1:443,8.8.8.8:443'),
  intervalMs: Number(env.INTERVAL_SEC || 30) * 1000,
  thresholdMs: Number(env.THRESHOLD_MS || 150),        // above this = slow
  spikeFactor: Number(env.SPIKE_FACTOR || 3),          // or above normal x this
  minSpikeMs: Number(env.MIN_SPIKE_MS || 50),          // ...but only if also above this
  consecutive: Number(env.CONSECUTIVE || 3),           // bad checks in a row before alerting
  cooldownMs: Number(env.COOLDOWN_MIN || 30) * 60000,  // reminder interval while still bad
  timeoutMs: 3000,                                     // no reply within this = RTO
  port: Number(env.PORT || 3000),
  mailTo: env.MAIL_TO,
  mailFrom: env.MAIL_FROM || env.SMTP_USER,
  dashPass: env.DASH_PASSWORD || '',
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  retentionDays: Number(env.RETENTION_DAYS || 30),
  reportOn: env.DAILY_REPORT !== 'off',
};
const HISTORY_MAX = 720;
fs.mkdirSync(cfg.dataDir, { recursive: true });

// ---------- Helpers ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const msText = v => (v === null ? '-' : `${v} ms`);
const fmtDur = ms => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const samplesFile = day => path.join(cfg.dataDir, `samples-${day}.jsonl`);
const eventsFile = path.join(cfg.dataDir, 'events.jsonl');
const metaFile = path.join(cfg.dataDir, 'meta.json');
const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return {}; } };
const writeMeta = m => fs.writeFileSync(metaFile, JSON.stringify(m));

// ---------- Email ----------
const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: Number(env.SMTP_PORT) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

async function sendMail(subject, text, attachments) {
  console.log(`[mail] ${subject}`);
  if (!transporter || !cfg.mailTo) {
    console.log('[mail] SMTP_HOST or MAIL_TO not set, email skipped.');
    return false;
  }
  try {
    await transporter.sendMail({ from: cfg.mailFrom, to: cfg.mailTo, subject, text, attachments });
    return true;
  } catch (err) {
    console.error('[mail] failed:', err.message);
    return false;
  }
}

// ---------- Probe (TCP connect time, no special privileges needed) ----------
function probe(target) {
  return new Promise(resolve => {
    const [host, port] = target.split(':');
    const start = process.hrtime.bigint();
    let socket;
    try {
      socket = net.connect({ host, port: Number(port), timeout: cfg.timeoutMs });
    } catch { return resolve(null); }
    const done = ms => { socket.destroy(); resolve(ms); };
    socket.once('connect', () => done(Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10));
    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}

// ---------- State, log and persistence ----------
const newDay = () => ({ key: '', total: 0, rto: 0, good: 0, sum: 0, min: null, max: null });
const state = new Map(cfg.targets.map(t => [t, {
  history: [], bad: 0, good: 0, alerting: false, lastAlert: 0, since: null, day: newDay(),
}]));
const events = [];

function logEvent(type, target, ms, note) {
  const e = { t: Date.now(), type, target, ms, note: note || '' };
  events.push(e);
  if (events.length > 1000) events.shift();
  fs.appendFile(eventsFile, JSON.stringify(e) + '\n', () => {});
}

function addToDay(s, ms, t) {
  const key = dayKey(new Date(t));
  if (s.day.key !== key) s.day = { ...newDay(), key };
  const d = s.day;
  d.total++;
  if (ms === null) { d.rto++; return; }
  d.good++; d.sum += ms;
  d.min = d.min === null ? ms : Math.min(d.min, ms);
  d.max = d.max === null ? ms : Math.max(d.max, ms);
}

function loadHistory() {
  try {
    for (const line of fs.readFileSync(samplesFile(dayKey(new Date())), 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const s = state.get(r.target);
      if (!s) continue;
      s.history.push({ t: r.t, ms: r.ms, bad: r.ms === null || r.ms > cfg.thresholdMs });
      addToDay(s, r.ms, r.t);
    }
    for (const s of state.values()) if (s.history.length > HISTORY_MAX) s.history = s.history.slice(-HISTORY_MAX);
  } catch {}
  try {
    for (const l of fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).slice(-1000)) {
      try { events.push(JSON.parse(l)); } catch {}
    }
  } catch {}
}

function prune() {
  const cutoff = Date.now() - cfg.retentionDays * 86400000;
  for (const f of fs.readdirSync(cfg.dataDir)) {
    const m = f.match(/^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && new Date(m[1] + 'T00:00:00').getTime() < cutoff) fs.unlink(path.join(cfg.dataDir, f), () => {});
  }
  try {
    const keep = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(l => {
      try { return l && JSON.parse(l).t >= cutoff; } catch { return false; }
    });
    fs.writeFileSync(eventsFile, keep.length ? keep.join('\n') + '\n' : '');
  } catch {}
}

// ---------- Detection ----------
function baseline(s) {
  const vals = s.history.filter(h => h.ms !== null && !h.bad).slice(-120).map(h => h.ms).sort((a, b) => a - b);
  return vals.length >= 20 ? vals[Math.floor(vals.length / 2)] : null;
}

function isBad(ms, base) {
  if (ms === null || ms > cfg.thresholdMs) return true;
  return base !== null && ms > base * cfg.spikeFactor && ms > cfg.minSpikeMs;
}

const recent = s => s.history.slice(-6).map(h => (h.ms === null ? 'RTO' : `${h.ms} ms`)).join(', ');

async function check(target) {
  const s = state.get(target);
  const base = baseline(s);
  const ms = await probe(target);
  const now = Date.now();
  const bad = isBad(ms, base);

  s.history.push({ t: now, ms, bad });
  if (s.history.length > HISTORY_MAX) s.history.shift();
  addToDay(s, ms, now);
  fs.appendFile(samplesFile(dayKey(new Date(now))), JSON.stringify({ t: now, target, ms }) + '\n', () => {});

  if (ms === null) logEvent('RTO', target, null, 'Request timed out');
  else if (bad) logEvent('SLOW', target, ms, base === null ? `Above ${cfg.thresholdMs} ms` : `Normal is about ${base} ms`);

  if (bad) { s.bad++; s.good = 0; } else { s.good++; s.bad = 0; }

  if (!s.alerting && s.bad >= cfg.consecutive) {
    s.alerting = true; s.lastAlert = now; s.since = now;
    logEvent('ALERT', target, ms, 'Alert email sent');
    await sendMail(`[Latency alert] ${target} is slow or unreachable`,
      `Target: ${target}\nTime: ${new Date(now).toISOString()}\nLatest: ${ms === null ? 'RTO (timeout)' : ms + ' ms'}\n` +
      `Normal (median): ${base === null ? 'still learning' : base + ' ms'}\nThreshold: ${cfg.thresholdMs} ms\n` +
      `Last checks: ${recent(s)}`);
  } else if (s.alerting && bad && now - s.lastAlert >= cfg.cooldownMs) {
    s.lastAlert = now;
    const mins = Math.round((now - s.since) / 60000);
    logEvent('ALERT', target, ms, `Still affected after ${mins} min`);
    await sendMail(`[Latency alert] ${target} still affected (${mins} min)`,
      `Target: ${target}\nLatest: ${ms === null ? 'RTO (timeout)' : ms + ' ms'}\nLast checks: ${recent(s)}`);
  } else if (s.alerting && s.good >= cfg.consecutive) {
    const mins = Math.round((now - s.since) / 60000);
    s.alerting = false;
    logEvent('RECOVERED', target, ms, `Back to normal after about ${mins} min`);
    await sendMail(`[Latency recovered] ${target} is back to normal`,
      `Target: ${target}\nLatest: ${ms} ms\nAffected for about ${mins} minutes.`);
  }
}

// ---------- Daily report ----------
function summarize(day) {
  let text;
  try { text = fs.readFileSync(samplesFile(day), 'utf8'); } catch { return null; }
  const rows = new Map(cfg.targets.map(t => [t, []]));
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (rows.has(r.target)) rows.get(r.target).push(r); } catch {}
  }
  const targets = [];
  for (const [target, list] of rows) {
    if (!list.length) continue;
    const hourly = Array.from({ length: 24 }, () => ({ sum: 0, n: 0, rto: 0 }));
    const good = [], outages = [];
    let run = null, slow = 0;
    for (const r of list) {
      const h = hourly[new Date(r.t).getHours()];
      if (r.ms === null) {
        h.rto++;
        if (!run) { run = { start: r.t, end: r.t, count: 0 }; outages.push(run); }
        run.end = r.t; run.count++;
      } else {
        run = null; h.sum += r.ms; h.n++; good.push(r.ms);
        if (r.ms > cfg.thresholdMs) slow++;
      }
    }
    good.sort((a, b) => a - b);
    const total = list.length, rto = total - good.length;
    targets.push({
      target, total, rto, slow, hourly, outages,
      uptime: ((total - rto) / total) * 100,
      avg: good.length ? Math.round((good.reduce((a, b) => a + b, 0) / good.length) * 10) / 10 : null,
      min: good.length ? good[0] : null,
      max: good.length ? good[good.length - 1] : null,
      p95: good.length ? good[Math.min(good.length - 1, Math.floor(good.length * 0.95))] : null,
    });
  }
  return targets.length ? { day, targets } : null;
}

function hourlyChart(doc, x, y, w, h, hourly) {
  const avgs = hourly.map(b => (b.n ? b.sum / b.n : 0));
  const max = Math.max(cfg.thresholdMs * 1.2, ...avgs);
  const bw = w / 24;
  doc.save();
  hourly.forEach((b, i) => {
    if (b.rto) doc.rect(x + i * bw, y, bw, h).fill('#fecaca');
    if (b.n) {
      const bh = Math.max((avgs[i] / max) * h, 1);
      doc.rect(x + i * bw + 1.5, y + h - bh, bw - 3, bh).fill(avgs[i] > cfg.thresholdMs ? '#b45309' : '#0f766e');
    }
    if (i % 3 === 0) doc.fillColor('#5d6f6a').fontSize(7).text(pad(i), x + i * bw, y + h + 3, { width: bw, lineBreak: false });
  });
  doc.rect(x, y, w, h).lineWidth(0.5).strokeColor('#d5dedb').stroke();
  const ty = y + h - (cfg.thresholdMs / max) * h;
  doc.moveTo(x, ty).lineTo(x + w, ty).dash(3, { space: 3 }).lineWidth(0.5).strokeColor('#b45309').stroke().undash();
  doc.restore();
}

function buildPdf(sum) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const L = 40, W = doc.page.width - 80, INK = '#14221f', MUTED = '#5d6f6a';

    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text('Connection report', L, 40);
    doc.font('Helvetica').fontSize(11).fillColor(MUTED)
      .text(`${sum.day}. Checked every ${cfg.intervalMs / 1000} seconds. Slow means above ${cfg.thresholdMs} ms.`, L);
    const totalRto = sum.targets.reduce((a, t) => a + t.rto, 0);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(totalRto ? '#b91c1c' : '#0f766e')
      .text(totalRto ? `${totalRto} timeouts (RTO) recorded across ${sum.targets.length} target(s).`
                     : 'No timeouts recorded. The connection stayed up.', L);

    for (const t of sum.targets) {
      if (doc.y > 440) doc.addPage();
      doc.moveDown(1.2);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(t.target, L);
      let y = doc.y + 6;
      [['Uptime', t.uptime.toFixed(2) + '%'], ['Checks', t.total], ['Timeouts', t.rto],
       ['Average', msText(t.avg)], ['Slowest', msText(t.max)], ['95th percentile', msText(t.p95)]]
        .forEach(([label, value], i) => {
          const x = L + (W / 6) * i;
          doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(String(value), x, y, { width: W / 6, lineBreak: false });
          doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label, x, y + 18, { width: W / 6, lineBreak: false });
        });
      y += 40;
      hourlyChart(doc, L, y, W, 70, t.hourly);
      y += 70 + 16;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text('Bars: average latency per hour (00 to 23). Red background: hour with timeouts. Dashed line: slow threshold.', L, y, { width: W });
      let ry = y + 24;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
        .text(t.outages.length ? `Timeouts: ${t.outages.length} outage(s)` : 'No timeouts recorded.', L, ry, { lineBreak: false });
      ry += 16;
      if (t.outages.length) {
        const cols = [0, 90, 180, 270];
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
        ['Start', 'End', 'Duration', 'Checks lost'].forEach((h, i) => doc.text(h, L + cols[i], ry, { lineBreak: false }));
        ry += 12;
        doc.font('Helvetica').fontSize(9).fillColor(INK);
        for (const o of t.outages.slice(0, 12)) {
          if (ry > 780) { doc.addPage(); ry = 40; }
          [clock(o.start), clock(o.end), fmtDur(o.end - o.start + cfg.intervalMs), String(o.count)]
            .forEach((v, i) => doc.text(v, L + cols[i], ry, { lineBreak: false }));
          ry += 13;
        }
        if (t.outages.length > 12) {
          doc.fillColor(MUTED).text(`${t.outages.length - 12} more outages are in the dashboard log.`, L, ry, { lineBreak: false });
          ry += 13;
        }
      }
      doc.x = L; doc.y = ry;
    }
    doc.end();
  });
}

async function sendReport(day) {
  const sum = summarize(day);
  if (!sum) return false;
  const pdf = await buildPdf(sum);
  const lines = sum.targets.map(t =>
    `${t.target}: uptime ${t.uptime.toFixed(2)}%, ${t.rto} timeouts, average ${msText(t.avg)}`);
  return sendMail(`Daily connection report ${day}`,
    `Connection summary for ${day}\n\n${lines.join('\n')}\n\nThe full report is attached.`,
    [{ filename: `connection-report-${day}.pdf`, content: pdf }]);
}

let nextReportTry = 0;
async function dailyReportCheck() {
  if (!cfg.reportOn || Date.now() < nextReportTry) return;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const day = dayKey(y);
  const meta = readMeta();
  if ((meta.lastReport || '') >= day || !fs.existsSync(samplesFile(day))) return;
  if (!transporter || !cfg.mailTo) {
    console.log(`[report] ${day}: SMTP not set, email skipped. Download it from the dashboard.`);
    return writeMeta({ ...meta, lastReport: day });
  }
  if (await sendReport(day)) writeMeta({ ...meta, lastReport: day });
  else nextReportTry = Date.now() + 10 * 60000; // retry in 10 minutes
}

async function tick() {
  await Promise.all(cfg.targets.map(t => check(t).catch(e => console.error('[check]', e.message))));
  try { await dailyReportCheck(); } catch (e) { console.error('[report]', e.message); }
}

// ---------- Web server ----------
function authorized(req) {
  if (!cfg.dashPass) return true;
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  return Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') === cfg.dashPass;
}

const sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Latency monitor"' });
    return res.end('Sign in required');
  }
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/status') {
    const data = cfg.targets.map(t => {
      const s = state.get(t);
      const last = s.history[s.history.length - 1] || null;
      const d = s.day.key === dayKey(new Date()) ? s.day : newDay();
      return {
        target: t,
        checked: !!last,
        lastChecked: last ? last.t : null,
        latest: last ? last.ms : null,
        ping: !last ? 'ok' : last.ms === null ? 'rto' : last.bad ? 'slow' : 'ok',
        alerting: s.alerting,
        since: s.since,
        baseline: baseline(s),
        today: {
          checks: d.total, rto: d.rto,
          uptime: d.total ? ((d.total - d.rto) / d.total) * 100 : null,
          avg: d.good ? Math.round((d.sum / d.good) * 10) / 10 : null,
          min: d.min, max: d.max,
        },
        series: s.history.slice(-120).map(h => h.ms),
      };
    });
    return sendJson(res, { thresholdMs: cfg.thresholdMs, intervalSec: cfg.intervalMs / 1000, data });
  }

  if (url.pathname === '/api/logs') {
    const type = url.searchParams.get('type') || 'ALL';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const match = e => type === 'ALL' || e.type === type || (type === 'ALERT' && e.type === 'RECOVERED');
    return sendJson(res, events.filter(match).slice(-limit).reverse());
  }

  if (url.pathname === '/report.pdf') {
    const q = url.searchParams.get('date') || '';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : dayKey(new Date());
    const sum = summarize(day);
    if (!sum) { res.writeHead(404); return res.end('No data for ' + day); }
    return buildPdf(sum).then(pdf => {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="connection-report-${day}.pdf"` });
      res.end(pdf);
    }).catch(err => { res.writeHead(500); res.end('Report failed: ' + err.message); });
  }

  if (req.method === 'POST' && url.pathname === '/api/send-report') {
    return sendReport(dayKey(new Date()))
      .then(ok => sendJson(res, { ok }))
      .catch(() => sendJson(res, { ok: false }, 500));
  }

  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, html) => {
    if (err) { res.writeHead(500); return res.end('Dashboard file missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

// ---------- Start ----------
if (process.argv.includes('--test-email')) {
  sendMail('[Latency monitor] Test email', 'If you can read this, email alerts are working.').then(() => process.exit(0));
} else {
  if (!cfg.targets.length) {
    console.error('No valid TARGETS found. Set TARGETS in .env, for example TARGETS=www.google.com:443');
    process.exit(1);
  }
  loadHistory();
  prune();
  setInterval(prune, 6 * 3600 * 1000);
  server.listen(cfg.port, () => console.log(`Dashboard on http://localhost:${cfg.port}`));
  console.log(`Monitoring ${cfg.targets.join(', ')} every ${cfg.intervalMs / 1000}s. Data in ${cfg.dataDir}`);
  tick();
  setInterval(tick, cfg.intervalMs);
}
