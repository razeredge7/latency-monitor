# Latency monitor

Runs on a computer inside your office network. It checks your connection every 30 seconds, shows a live dashboard with a
log of every timeout (RTO), emails you when the connection looks abnormal, and emails a PDF report every day.

## What you need
- A computer or server inside the office network that stays on all day (a spare PC, mini PC or Raspberry Pi is fine).
- Docker (Step 1), or Node.js 20+ if you prefer not to use Docker (see the end of this file).
- An email account that can send mail through SMTP. For Gmail you need an "app password" (Step 4).

## Folder layout
Keep the files exactly like this. `index.html` must be inside the `public` folder.

    latency-monitor/
      server.js
      package.json
      Dockerfile
      docker-compose.yml
      .env.example
      README.md
      public/
        index.html

## Step by step (Docker)

### Step 1. Install Docker
- Windows or Mac: install Docker Desktop from docker.com, open it, and wait until it says Docker is running.
- Linux: install Docker Engine and the compose plugin from docs.docker.com/engine/install.
Check it works by opening a terminal and running: `docker --version` and `docker compose version`

### Step 2. Put the project on the office computer
Copy the whole `latency-monitor` folder to the computer (or unzip `latency-monitor.zip`). Open a terminal inside that folder.

### Step 3. Create your settings file
Copy `.env.example` to a new file named `.env` (same folder):
- Mac or Linux: `cp .env.example .env`
- Windows (Command Prompt): `copy .env.example .env`
Open `.env` in a text editor. You will fill it in over the next steps. If your computer hides files that start with a dot,
turn on "show hidden files", or create a new text file and name it `.env`.

### Step 4. Set up email (Gmail example)
1. In your Google account, turn on 2-Step Verification (Security page).
2. Search for "App passwords" in your Google account, create one named "latency monitor", and copy the 16-character password.
3. In `.env`, set:

       SMTP_HOST=smtp.gmail.com
       SMTP_PORT=587
       SMTP_USER=youraddress@gmail.com
       SMTP_PASS=the-16-character-app-password
       MAIL_FROM=youraddress@gmail.com
       MAIL_TO=where-you-want-alerts@example.com

Other email providers work too. Use the SMTP host, port, username and password your provider gives you.

### Step 5. Choose what to measure and your timezone
In `.env`:
- `TARGETS` is a comma-separated list of `host:port`. Keep the two defaults for general internet health, and add your own
  server or website, for example: `TARGETS=1.1.1.1:443,8.8.8.8:443,yourcompany.com:443`
- `TZ` is your timezone, for example `Asia/Jakarta`. The daily report covers one calendar day in this timezone.
- Optional: set `DASH_PASSWORD` to protect the dashboard (log in with any username and this password).
You can leave everything else at its default (slow means above 150 ms, alert after 3 bad checks in a row).

### Step 6. Start it
In the terminal, inside the project folder, run:

    docker compose up -d --build

The first run downloads Node and the libraries, so it takes a few minutes. Later starts are fast.

### Step 7. Open the dashboard
Go to http://localhost:3000 in a browser. From another computer in the office, use http://THE-COMPUTER-IP:3000.
After about a minute you will see the status, latency and graph for each target.

### Step 8. Test that email works
Run:

    docker compose exec latency-monitor node server.js --test-email

You should receive a test email within a minute. If not, check the troubleshooting section.

### Step 9. Test the report
Let it run for a few minutes, then on the dashboard press "Open today's report (PDF)" to see the report, and "Email report now"
to receive it by email. Check that the PDF looks right.

### Step 10. See an RTO get logged (optional test)
Temporarily add a target that does not exist, for example `TARGETS=1.1.1.1:443,10.255.255.1:443`, then run
`docker compose up -d`. Within about 30 seconds the dashboard shows RTO, and the Log table lists "Timeout (RTO)" entries.
After 3 bad checks in a row you get an alert email. Put your real targets back and run `docker compose up -d` again.

## Daily use
- It starts automatically when the computer restarts (`restart: always`).
- The daily PDF report is emailed just after midnight for the day that ended.
- Past reports: http://localhost:3000/report.pdf?date=2026-10-25 (use the date you want).
- Logs and history are saved in the `data` folder next to `docker-compose.yml`, and kept for 30 days.

## Useful commands (run inside the project folder)
- See what it is doing: `docker compose logs -f`
- Stop it: `docker compose down`
- Apply changes after editing `.env`: `docker compose up -d`
- Apply changes after editing code: `docker compose up -d --build`

## What the settings mean
- RTO: a check that got no reply within 3 seconds.
- Slow: a reply above THRESHOLD_MS, or more than 3 times the recent normal (and above 50 ms).
- Alert email: sent after CONSECUTIVE bad checks in a row, repeated every COOLDOWN_MIN minutes while the problem continues,
  followed by a recovery email.
- RETENTION_DAYS: how many days of history and logs to keep.

## Troubleshooting
- No emails: run the test in Step 8 and read `docker compose logs`. For Gmail, make sure you used an app password, not your normal
  password. Port 587 is for most providers; use 465 if your provider says so.
- Dashboard will not open: run `docker compose ps` and check the container is running. Make sure nothing else uses port 3000.
- Everything shows RTO: the computer may block outgoing connections on port 443, or cannot reach the internet.
  Try a target inside your network, such as your router: `192.168.1.1:80`.
- Dashboard empty after restart: check that the `data` folder is next to `docker-compose.yml` and is not read-only.
- If the whole office internet is down, the alert email cannot be sent either. It will be sent when the connection returns.

## Without Docker
1. Install Node.js 20 or newer from nodejs.org.
2. In the project folder run `npm install`.
3. Create `.env` as in Steps 3 to 5.
4. Run `node --env-file=.env server.js` and open http://localhost:3000.
Use a tool such as pm2 or a Windows scheduled task if you want it to start automatically.
