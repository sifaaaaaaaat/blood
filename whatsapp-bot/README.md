# RoktoSathi WhatsApp bridge (free, whatsapp-web.js)

A small always-on Node process that keeps **one** WhatsApp session alive and
relays messages in both directions between WhatsApp and the RoktoSathi app.

It uses no WhatsApp Business API, no Meta fees and no monthly plan. It is
**unofficial** (it drives WhatsApp Web with your own account), so pair a
dedicated number rather than a personal one.

## What it does

| Direction | Path |
|---|---|
| App → donor | The app's notification outbox calls `POST /send` on this bridge. |
| Donor → app | A donor's reply arrives here, is forwarded to the app's webhook, and the app's answer is sent back into the same chat. |

All conversation logic (accept, the 3-month question, when a donor's number may
be shared) lives in the **app**, never in this bridge — the bridge only relays
text.

## Run it

```bash
cd whatsapp-bot
npm install
node bot.js
```

The first run prints a QR code — scan it with the phone that owns the session
(WhatsApp → Linked devices → Link a device), or open <http://localhost:3001/qr>.
The session then persists in `.wwebjs_auth/`, so later runs start without a QR.

## Configuration (`whatsapp-bot/.env`)

| Variable | Meaning |
|---|---|
| `WHATSAPP_BOT_TOKEN` | Shared secret. Must equal `WHATSAPP_BOT_TOKEN` in the app's `.env.local`. |
| `BRIDGE_PORT` | Bridge port (default `3001`). `PORT` is a fallback for PaaS hosts. |
| `APP_INBOUND_URL` | Where donor replies are forwarded. |
| `WWEBJS_DATA_PATH` | Folder holding the linked-device session (default `.wwebjs_auth`). On a server point it **outside** the checkout, e.g. `/var/lib/roktosathi-bridge`. |
| `CHROME_PATH` | Optional system Chrome/Chromium binary. Empty = puppeteer's bundled build. |
| `QR_PUBLIC` | `false` (default) token-gates the pairing page. Only set `true` for local pairing. |

`APP_INBOUND_URL` decides which app instance answers replies:

- **Local development:** `http://localhost:<dev-port>/api/whatsapp/inbound`
  (the dev port changes when 3000 is busy — copy the `Local:` line from the dev
  server output).
- **Production:** `https://<your-app>.vercel.app/api/whatsapp/inbound`.
  Replies then go through the live site, which needs no tunnel because this
  direction is the bridge calling out over HTTPS.

## Endpoints

All require the header `x-bot-token: <WHATSAPP_BOT_TOKEN>` except `/qr`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/status` | `{ ready, paired, info }` — session health. |
| `GET` | `/qr` | Pairing page. Requires `?token=<WHATSAPP_BOT_TOKEN>` unless `QR_PUBLIC=true`. |
| `POST` | `/send` | `{ phone: "8801XXXXXXXXX", text: "..." }` — send one message. |
| `GET` | `/health` | `{ ok, ready }` — unauthenticated liveness probe. |

## Running it 24/7 (recommended)

A laptop is the wrong host for this: donor alerts stop whenever it sleeps.
Run it on a small always-on VM instead — the whole setup is one script:

```bash
sudo bash deploy/setup-vm.sh --token '<YOUR_WHATSAPP_BOT_TOKEN>'
```

It installs Node, Chrome and Caddy (HTTPS), creates a `bridge` user, registers a
systemd service, and prints a public `https://…sslip.io` URL to put in Vercel as
`WHATSAPP_BOT_URL`. Step-by-step, including the cloud firewall and the one-time
QR pairing: [`deploy/README.md`](deploy/README.md).

## Notes

- Replies are attributed to the **sender's own number**. Modern WhatsApp
  accounts are LID-keyed, so the bridge asks WhatsApp for the phone behind a
  LID (and remembers every chat it started) before forwarding a reply.
- Keep the process running whenever donor alerts are needed. If the phone loses
  its linked-device session, run `node bot.js` and scan a fresh QR.
- If WhatsApp reports an error for a phone number, that number is not reachable
  on WhatsApp — the app records the failure and does not retry it forever.
