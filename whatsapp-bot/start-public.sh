#!/usr/bin/env bash
# ============================================================================
# Start the bridge + a public HTTPS tunnel, then print the URL Vercel needs.
#
#   bash start-public.sh
#
# Use this while the bridge still runs on your PC. The quick tunnel gets a NEW
# random hostname every time it starts, so if the printed URL differs from the
# one in Vercel (WHATSAPP_BOT_URL), update that variable and redeploy — or move
# to the VM (deploy/README.md), which keeps one stable address.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "missing .env — copy .env.example and fill it in"; exit 1; }
mkdir -p .tools

if [ ! -f .tools/cloudflared.exe ]; then
  echo "downloading cloudflared…"
  curl -fsSL -o .tools/cloudflared.exe \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
fi

# Bridge on 3001 if nothing is listening there yet.
if ! curl -s --max-time 2 http://127.0.0.1:3001/health >/dev/null 2>&1; then
  echo "starting the bridge…"
  nohup node bot.js > bot-live.log 2>&1 &
  for _ in $(seq 1 30); do
    curl -s --max-time 2 http://127.0.0.1:3001/health >/dev/null 2>&1 && break
    sleep 2
  done
fi

echo "bridge: $(curl -s --max-time 3 http://127.0.0.1:3001/health || echo 'not answering')"

echo "starting the tunnel…"
nohup .tools/cloudflared.exe tunnel --url http://localhost:3001 --no-autoupdate \
  > .tools/tunnel.log 2>&1 &

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .tools/tunnel.log 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done

if [ -z "$URL" ]; then
  echo "could not read the tunnel URL — check .tools/tunnel.log"
  exit 1
fi

echo
echo "PUBLIC URL: $URL"
echo "health    : $(curl -s --max-time 20 "$URL/health" || echo 'not answering yet')"
echo
echo "Set WHATSAPP_BOT_URL=$URL in Vercel (Production) and redeploy if it changed."
echo "The session survives restarts; if /health says ready:false, open:"
echo "  $URL/qr?token=<WHATSAPP_BOT_TOKEN>"
