FROM node:20-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
