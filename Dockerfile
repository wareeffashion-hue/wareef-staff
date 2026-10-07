FROM node:22-alpine
WORKDIR /app
# Headless Chromium turns the daily report into the PDF that goes to the manager's WhatsApp.
RUN apk add --no-cache chromium font-noto-arabic font-liberation
ENV CHROMIUM_PATH=/usr/bin/chromium-browser PUPPETEER_SKIP_DOWNLOAD=1 NODE_ENV=production PORT=3000 DB_PATH=/data/staff.db SECURE_COOKIES=1 TZ_OFFSET=+03:00
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
# Runs as root: Railway mounts volumes owned by root, so a non-root user can't write /data.
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
