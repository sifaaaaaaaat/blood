# RoktoSathi WhatsApp bridge — container image.
#
# For any Docker host (Caasify, Render, Northflank, a VPS…). Chromium comes from
# the distro so Puppeteer never downloads its own browser.
#
#   docker build -t roktosathi-bridge .
#   docker run -d --name bridge -p 3001:3001 \
#     -e WHATSAPP_BOT_TOKEN='<same token as the app>' \
#     -v roktosathi-session:/data \
#     roktosathi-bridge
#
# The named volume on /data is NOT optional: it holds the linked-device session,
# so without it every restart needs a fresh QR scan.
FROM node:22-bookworm-slim

# dumb-init keeps the Node process as PID 1's child so SIGTERM reaches bot.js,
# which flushes the session to disk on shutdown instead of corrupting it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation dumb-init curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    WWEBJS_DATA_PATH=/data \
    BRIDGE_PORT=3001

WORKDIR /app

# Dependencies first so code edits don't invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3001

# /health is unauthenticated and reports readiness of the WhatsApp session.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "bot.js"]
