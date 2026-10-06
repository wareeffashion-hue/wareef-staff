FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/staff.db SECURE_COOKIES=1 TZ_OFFSET=+03:00
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
