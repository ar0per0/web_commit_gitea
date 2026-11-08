FROM node:22-alpine3.22

RUN apk add --no-cache git docker-cli docker-cli-buildx ca-certificates tzdata

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_PATH=/data \
    TZ=Europe/Madrid

COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/

RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8804

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8804/styles.css', { signal: AbortSignal.timeout(4000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
