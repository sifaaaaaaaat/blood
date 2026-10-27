#!/usr/bin/env bash
# ============================================================================
# RoktoSathi WhatsApp bridge — one-shot setup for a fresh free-tier VM.
#
# Target: Ubuntu 22.04 / 24.04 (Oracle Cloud Always Free, Google Cloud
# e2-micro, or any small VPS). Run ON THE VM, not on your laptop:
#
#   sudo bash setup-vm.sh --token <WHATSAPP_BOT_TOKEN>
#
# Optional:
#   --app-inbound URL   where donor replies are forwarded
#                       (default: https://blood-gamma-nine.vercel.app/api/whatsapp/inbound)
#   --hostname HOST     public hostname for HTTPS
#                       (default: bridge.<public-ip>.sslip.io — resolves to the
#                        VM's IP without owning a domain)
#   --repo URL          git repo to deploy (default: the public RoktoSathi repo)
#
# Idempotent: re-running updates the code and restarts the service without
# touching the paired WhatsApp session in /var/lib/roktosathi-bridge.
#
# What it installs: Node 22, Google Chrome (or Chromium on ARM), Caddy for
# HTTPS, a `bridge` system user, a systemd unit, and firewall rules for 80/443.
# ============================================================================
set -euo pipefail

TOKEN=""
APP_INBOUND="https://blood-gamma-nine.vercel.app/api/whatsapp/inbound"
HOSTNAME_ARG=""
REPO="https://github.com/sifaaaaaaaat/blood.git"

APP_DIR="/opt/roktosathi-bridge"
DATA_DIR="/var/lib/roktosathi-bridge"
ENV_DIR="/etc/roktosathi-bridge"
ENV_FILE="$ENV_DIR/env"
SERVICE="roktosathi-bridge"
PORT="3001"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[error] %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token)       TOKEN="${2:-}"; shift 2 ;;
    --app-inbound) APP_INBOUND="${2:-}"; shift 2 ;;
    --hostname)    HOSTNAME_ARG="${2:-}"; shift 2 ;;
    --repo)        REPO="${2:-}"; shift 2 ;;
    -h|--help)     sed -n '2,28p' "$0"; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 --token <token>"
command -v apt-get >/dev/null || die "this script targets Ubuntu/Debian (apt-get not found)"

if [ -z "$TOKEN" ]; then
  printf 'WHATSAPP_BOT_TOKEN (hidden input): '
  read -rs TOKEN
  printf '\n'
fi
[ -n "$TOKEN" ] || die "a token is required — it must equal WHATSAPP_BOT_TOKEN in the app"
[ ${#TOKEN} -ge 16 ] || warn "that token is shorter than 16 chars; consider a longer random secret"

ARCH="$(uname -m)"
log "architecture: $ARCH"

# ---------------------------------------------------------------------------
# 1. Base packages
# ---------------------------------------------------------------------------
log "installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git jq ufw >/dev/null

# ---------------------------------------------------------------------------
# 2. Node.js 22 (Ubuntu's own nodejs is too old for whatsapp-web.js)
# ---------------------------------------------------------------------------
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  log "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
log "node: $($NODE_BIN -v) at $NODE_BIN"

# ---------------------------------------------------------------------------
# 3. Chrome / Chromium (whatsapp-web.js drives a real browser)
# ---------------------------------------------------------------------------
CHROME_PATH=""
if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
  if command -v google-chrome-stable >/dev/null; then
    CHROME_PATH="$(command -v google-chrome-stable)"
  else
    log "installing Google Chrome (x86_64)"
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y -qq /tmp/chrome.deb >/dev/null
    rm -f /tmp/chrome.deb
    CHROME_PATH="$(command -v google-chrome-stable)"
  fi
else
  # ARM (e.g. Oracle Ampere): Google publishes no ARM Linux build, so use the
  # distribution's Chromium. On Ubuntu that package is a snap.
  if command -v chromium >/dev/null; then
    CHROME_PATH="$(command -v chromium)"
  elif command -v chromium-browser >/dev/null; then
    CHROME_PATH="$(command -v chromium-browser)"
  else
    log "installing Chromium (ARM)"
    apt-get install -y -qq chromium-browser >/dev/null 2>&1 || true
    snap install chromium >/dev/null 2>&1 || true
    for cand in /snap/bin/chromium /usr/bin/chromium /usr/bin/chromium-browser; do
      [ -x "$cand" ] && CHROME_PATH="$cand" && break
    done
  fi
fi
[ -n "$CHROME_PATH" ] || die "no Chrome/Chromium binary found — install one and re-run"
log "chrome: $CHROME_PATH"

# ---------------------------------------------------------------------------
# 4. Swap on small VMs (Chrome needs headroom; 1GB machines OOM without it)
# ---------------------------------------------------------------------------
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
if [ "$MEM_MB" -lt 2048 ] && [ ! -f /swapfile ]; then
  log "RAM is ${MEM_MB}MB — adding a 2GB swap file"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------------------
# 5. System user + directories
# ---------------------------------------------------------------------------
if ! id bridge >/dev/null 2>&1; then
  log "creating system user 'bridge'"
  useradd --system --create-home --shell /usr/sbin/nologin bridge
fi
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR"
chown -R bridge:bridge "$DATA_DIR"

# ---------------------------------------------------------------------------
# 6. Code
# ---------------------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "updating existing checkout"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  log "cloning $REPO"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

log "installing bridge dependencies"
cd "$APP_DIR/whatsapp-bot"
# System Chrome is used instead of puppeteer's own download (saves ~200MB and
# avoids a second browser on a small disk).
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund >/dev/null
chown -R bridge:bridge "$APP_DIR"

# ---------------------------------------------------------------------------
# 7. Environment file (secret, readable only by the service user)
# ---------------------------------------------------------------------------
log "writing $ENV_FILE"
umask 077
cat > "$ENV_FILE" <<EOF
# RoktoSathi WhatsApp bridge — managed by deploy/setup-vm.sh
WHATSAPP_BOT_TOKEN=$TOKEN
BRIDGE_PORT=$PORT
APP_INBOUND_URL=$APP_INBOUND
WWEBJS_DATA_PATH=$DATA_DIR
CHROME_PATH=$CHROME_PATH
QR_PUBLIC=false
EOF
chown root:bridge "$ENV_FILE"
chmod 640 "$ENV_FILE"
umask 022

# ---------------------------------------------------------------------------
# 8. systemd service
# ---------------------------------------------------------------------------
log "installing systemd unit"
install -m 0644 "$APP_DIR/whatsapp-bot/deploy/roktosathi-bridge.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# ---------------------------------------------------------------------------
# 9. HTTPS reverse proxy (Caddy + sslip.io: no domain purchase needed)
# ---------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
BRIDGE_HOST="${HOSTNAME_ARG:-bridge.${PUBLIC_IP}.sslip.io}"

if ! command -v caddy >/dev/null; then
  log "installing Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

log "configuring Caddy for $BRIDGE_HOST"
install -m 0644 "$APP_DIR/whatsapp-bot/deploy/Caddyfile.template" /etc/caddy/Caddyfile
sed -i "s|__BRIDGE_HOSTNAME__|$BRIDGE_HOST|g; s|__BRIDGE_PORT__|$PORT|g" /etc/caddy/Caddyfile
mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

# ---------------------------------------------------------------------------
# 10. Firewall
# ---------------------------------------------------------------------------
log "opening ports 22/80/443"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
# Oracle images ship iptables REJECT rules that block everything but SSH.
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT 2>/dev/null || true
  done
  if command -v netfilter-persistent >/dev/null; then
    netfilter-persistent save >/dev/null 2>&1 || true
  elif [ -d /etc/iptables ]; then
    iptables-save > /etc/iptables/rules.v4 || true
  fi
fi

# ---------------------------------------------------------------------------
# 11. Wait for the bridge, then report
# ---------------------------------------------------------------------------
log "waiting for the bridge to answer on :$PORT"
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

READY="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || echo '{"ready":false}')"
BRIDGE_URL="https://$BRIDGE_HOST"

cat <<EOF

============================================================================
 RoktoSathi WhatsApp bridge is installed.
============================================================================
 Public URL      : $BRIDGE_URL
 Health          : $BRIDGE_URL/health
 Pairing page    : $BRIDGE_URL/qr?token=YOUR_WHATSAPP_BOT_TOKEN
 Service         : systemctl status $SERVICE
 Logs            : journalctl -u $SERVICE -f
 Session folder  : $DATA_DIR
 Status now      : $READY

 NEXT STEPS
 1. Open the console firewall for this VM and allow TCP 80 and 443 from
    0.0.0.0/0 (Oracle: Networking → VCN → Security List; GCP: VPC → Firewall).
    Without that, Caddy cannot obtain its HTTPS certificate.
 2. Put these in the Vercel project (Settings → Environment Variables,
    Production) and redeploy:
        WHATSAPP_BOT_URL=$BRIDGE_URL
        WHATSAPP_BOT_TOKEN=<the token you passed to this script>
 3. Open the pairing page and scan the QR with the phone that will send
    donor alerts (WhatsApp → Linked devices → Link a device).
 4. Verify: curl $BRIDGE_URL/health  →  {"ok":true,"ready":true}
============================================================================
EOF
