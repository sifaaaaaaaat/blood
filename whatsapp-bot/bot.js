/**
 * RoktoSathi FREE WhatsApp bridge (whatsapp-web.js based).
 *
 * What this is:
 *   A small always-on Node process that keeps ONE WhatsApp session alive
 *   (the account paired with the QR code) and exposes a tiny authenticated
 *   HTTP API so the RoktoSathi app can send messages.
 *
 *   It uses NO WhatsApp Business API, NO Meta fees, NO monthly plan. It
 *   browser-automates WhatsApp Web with your own account — free, but note:
 *   this is an unofficial library. WhatsApp may ban the number used, so pair
 *   a dedicated number, not your personal one.
 *
 * Run:   npm install && npm start    (first run prints a QR you scan from
 *   the phone that owns the session; the session then persists in .wwebjs_auth)
 *
 * Hosting: this process is meant to run 24/7 on a small always-on machine (a
 * free-tier VM), NOT on a laptop, because every donor alert passes through it.
 * See deploy/README.md. For a hosted setup set WWEBJS_DATA_PATH to a directory
 * that survives restarts (that folder IS the linked-device session) and
 * CHROME_PATH to the system Chrome if the bundled one is missing.
 *
 * Endpoints (all require header  x-bot-token: <same token as the app>):
 *   GET  /status  → { ready, paired, info }
 *   GET  /qr      → pairing page (token required when exposed publicly)
 *   POST /send    → { phone: "8801XXXXXXXXX", text: "..." }
 *   GET  /health  → { ok, ready } — unauthenticated liveness probe
 */
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const crypto = require("node:crypto");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

// Own env vars only: the host shell may carry PORT=0, which would bind to a
// random/invalid port and make the bridge unreachable. BRIDGE_PORT wins; PORT
// is honoured as a fallback so PaaS hosts that inject a port still work.
const PORT = Number(process.env.BRIDGE_PORT || process.env.PORT) || 3001;
const TOKEN = process.env.WHATSAPP_BOT_TOKEN || "";
// Where donor replies are interpreted (the RoktoSathi app). All conversation
// logic lives there; this bridge only relays text in both directions.
const APP_INBOUND_URL =
  process.env.APP_INBOUND_URL || "http://localhost:3000/api/whatsapp/inbound";
// Directory holding the linked-device session. On a server this must be a path
// outside the app checkout (e.g. /var/lib/roktosathi-bridge) so redeploys and
// `git pull` never wipe the pairing.
const DATA_PATH = process.env.WWEBJS_DATA_PATH || ".wwebjs_auth";
// Chrome/Chromium binary. Unset = use the one puppeteer downloaded at install.
const CHROME_PATH = process.env.CHROME_PATH || "";
// Public deployment: the pairing page can link *any* phone to this session, so
// it is token-gated whenever the bridge is not bound to loopback.
const QR_PUBLIC = String(process.env.QR_PUBLIC ?? "false").toLowerCase() === "true";

try {
  fs.mkdirSync(DATA_PATH, { recursive: true });
} catch (e) {
  console.error(`cannot create session dir ${DATA_PATH}:`, e?.message);
  process.exit(1);
}

if (!TOKEN) {
  console.error("WHATSAPP_BOT_TOKEN is missing — refusing to start (writes would be unauthenticated).");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "64kb" }));

let latestQr = null;
let ready = false;
let starting = true;
// Watchdog state: WhatsApp Web sometimes authenticates and then never emits
// "ready", leaving a session that looks alive but can send nothing.
let lastEventAt = Date.now();
let autoRestarts = 0;
const touch = () => {
  lastEventAt = Date.now();
};
const STALL_MS = 120_000;
const MAX_AUTO_RESTARTS = 5;

/**
 * chatId -> digits-only phone, remembered for every chat we send to.
 *
 * Modern WhatsApp accounts are LID-keyed: the same person appears as
 * "<lid>@lid", whose digits are NOT their phone number. Remembering the chat
 * we actually messaged lets an inbound reply be attributed to the right number
 * even when WhatsApp reports the sender as a LID.
 */
const chatPhones = new Map();

/** Best-effort real phone number for an inbound sender. */
async function resolveSenderPhone(msg) {
  const from = String(msg.from || "");

  // 1. Authoritative: the library's LID <-> phone lookup.
  try {
    const [{ pn, lid } = {}] = (await client.getContactLidAndPhone(from)) || [];
    const best = pn || lid;
    if (best) {
      const digits = String(best).split("@")[0].replace(/[^0-9]/g, "");
      if (/^[0-9]{8,15}$/.test(digits)) return digits;
    }
  } catch (e) {
    console.warn("LID/phone lookup failed:", e?.message);
  }

  // 2. Memory of chats we started (see /send).
  const remembered = chatPhones.get(from);
  if (remembered) return remembered;

  // 3. Last resort: the raw digits of the sender id.
  const raw = from.split("@")[0].replace(/[^0-9]/g, "");
  return /^[0-9]{8,15}$/.test(raw) ? raw : "";
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: DATA_PATH }),
  puppeteer: {
    headless: true,
    // Only override when CHROME_PATH is set; otherwise puppeteer's own build.
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Required on small servers/containers where /dev/shm is tiny.
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
});

client.on("qr", async (qr) => {
  touch();
  latestQr = qr;
  console.log("\n=== Scan this QR with WhatsApp → Linked devices → Link a device ===\n");
  console.log(qrcode.toString(qr, { small: true }));
  console.log(
    "\n(or open " +
      (QR_PUBLIC
        ? `http://localhost:${PORT}/qr`
        : `http://localhost:${PORT}/qr?token=<WHATSAPP_BOT_TOKEN>`) +
      " in a browser)\n"
  );
});

/**
 * Inbound donor replies.
 *
 * Messages from the paired account itself, groups, statuses and broadcasts are
 * ignored. Everything else is relayed to the app, which answers with the
 * replies to send back into the same chat — so the conversation rules (accept,
 * the 3-month question, contact sharing) are enforced server-side and cannot
 * be guessed by whoever holds the phone.
 */
client.on("message", async (msg) => {
  try {
    if (msg.fromMe || msg.isStatus) return;
    if (msg.from === "status@broadcast" || String(msg.from || "").endsWith("@g.us")) return;
    const chat = await msg.getChat().catch(() => null);
    if (chat?.isGroup) return;

    const phone = await resolveSenderPhone(msg);
    const text = String(msg.body || "").trim();
    if (!phone || !text) return;

    console.log("inbound from", `+${phone}`, "(chat", String(msg.from || ""), ") →", text.slice(0, 40));
                                     
    const res = await fetch(APP_INBOUND_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bot-token": TOKEN },
      body: JSON.stringify({ phone, text }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("app rejected inbound reply:", res.status, payload?.message || "");
      return;
    }
    for (const reply of payload?.data?.replies || []) {
      if (typeof reply !== "string" || !reply) continue;
      await client.sendMessage(msg.from, reply.slice(0, 2000));
      console.log("replied to", `+${phone}`);
    }
  } catch (e) {
    console.error("inbound handling failed:", e?.message);
  }
});

client.on("authenticated", () => {
  touch();
  console.log("[ev] authenticated");
});
client.on("loading_screen", (pct, msg) => {
  touch();
  console.log(`[ev] loading_screen ${pct}% ${msg ?? ""}`);
});
client.on("loading_screen_failure", (err) => console.error("[ev] loading_screen FAILURE:", err));
client.on("remote_session_saved", () => console.log("[ev] remote_session_saved"));

client.on("ready", () => {
  touch();
  ready = true;
  starting = false;
  autoRestarts = 0;
  latestQr = null;
  // whatsapp-web.js exposes the paired account via client.info (no getMe()).
  const me = client.info;
  console.log("WhatsApp session READY — connected as", me ? `+${me.wid?.user ?? "unknown"}` : "(unknown wid)");
});

client.on("auth_failure", (msg) => {
  ready = false;
  starting = false;
  console.error("AUTH FAILURE:", msg);
});

client.on("disconnected", (reason) => {
  ready = false;
  starting = false;
  console.warn("WhatsApp disconnected:", reason, "— re-initializing…");
  client.initialize();
});

function isPhone(p) {
  return typeof p === "string" && /^[0-9]{8,15}$/.test(p); // digits only, international format without +
}

/**
 * Pairing page. On a public host anyone who loads it could scan it with their
 * own phone and take over the session slot, so it requires the bridge token in
 * the query string (it is also accepted as the header). Set QR_PUBLIC=true
 * only for a quick local pairing.
 */
app.get("/qr", async (req, res) => {
  if (!QR_PUBLIC) {
    const supplied = String(req.query.token || req.get("x-bot-token") || "");
    const a = Buffer.from(supplied);
    const b = Buffer.from(TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send("<h1>Unauthorized</h1><p>Open this page with ?token=YOUR_WHATSAPP_BOT_TOKEN</p>");
    }
  }
  // Auto-refresh: WhatsApp QRs expire in ~20s, and a stale image is the most
  // common reason a remote pairing attempt fails.
  res.set("cache-control", "no-store");
  if (!latestQr) {
    return res.status(200).send(
      `<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding-top:40px">
        <h1>${ready ? "Already paired ✅" : "No QR yet — starting…"}</h1>
        <p>This page refreshes itself.</p></body></html>`
    );
  }
  const dataUrl = await qrcode.toDataURL(latestQr);
  res.send(`<html><head><meta http-equiv="refresh" content="20"></head><body style="font-family:sans-serif;text-align:center;padding-top:40px">
    <h2>RoktoSathi WhatsApp bridge — pair your number</h2>
    <p>WhatsApp app → Settings → Linked devices → Link a device</p>
    <img src="${dataUrl}" width="320" height="320"/>
    <p>Codes expire in ~20s; this page reloads with a fresh one.</p></body></html>`);
});

// Unauthenticated liveness probe for uptime monitors / the host's healthcheck.
// Deliberately reveals nothing but "up" and whether the session is usable.
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ready });
});

function authed(req, res, next) {
  const t = req.get("x-bot-token") || "";
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/status", authed, async (_req, res) => {
  let info = null;
  if (ready && client.info) {
    info = { phone: `+${client.info.wid?.user ?? "unknown"}`, pushname: client.info.pushname ?? null };
  }
  res.json({ ready, paired: ready, info });
});

app.post("/send", authed, async (req, res) => {
  const phone = req.body?.phone;
  const text = req.body?.text;
  if (!isPhone(phone)) return res.status(400).json({ error: "phone must be digits-only international format, e.g. 8801712345678" });
  if (typeof text !== "string" || text.length === 0 || text.length > 2000) return res.status(400).json({ error: "text must be 1-2000 chars" });
  if (!ready) return res.status(503).json({ error: "bot not ready — pair the session first (open /qr)" });

  try {
    // Resolve the correct chat id first: modern WhatsApp accounts (LID) can
    // NOT be addressed as <phone>@c.us directly — that fails with
    // "No LID for user". getNumberId maps the number to the right JID and
    // returns null if the number is not on WhatsApp. Some LID-keyed accounts
    // make getNumberId THROW even though the chat exists — so a thrown
    // resolve must fall back to a direct legacy send instead of failing.
    let chatId = null;
    try {
      const numberId = await client.getNumberId(phone);
      chatId = numberId ? (numberId._serialized ?? String(numberId)) : null;
    } catch (resolveErr) {
      console.warn("getNumberId failed (falling back to legacy id):", resolveErr?.message);
    }
    if (!chatId) chatId = `${phone}@c.us`;
    // Remember which chat belongs to this number so an inbound reply from a
    // LID-keyed sender can still be attributed to the right donor.
    chatPhones.set(chatId, phone);
    const msg = await client.sendMessage(chatId, text.slice(0, 2000));
    // If the legacy-direct send is rejected with a LID error, the number is
    // genuinely unusable (not on WhatsApp / no mapping) — surface that clearly.
    const serialized = msg?.id?._serialized ?? msg?.id?.id ?? "";
    console.log("sent to", chatId, "→", serialized);
    return res.json({ ok: true, id: serialized, chatId });
  } catch (e) {
    console.error("send failed:", e?.message, "\n", e?.stack);
    return res.status(502).json({ error: "send failed: " + (e?.message ?? "unknown") });
  }
});

/**
 * Watchdog: a session that authenticates but never becomes ready (a real
 * WhatsApp Web failure seen in practice) is restarted automatically, so donor
 * alerts keep flowing without someone noticing a silent bridge.
 */
setInterval(async () => {
  if (ready) return;
  if (Date.now() - lastEventAt < STALL_MS) return;
  if (autoRestarts >= MAX_AUTO_RESTARTS) {
    console.error(
      `session still not ready after ${MAX_AUTO_RESTARTS} automatic restarts — open http://localhost:${PORT}/qr and link the phone again`
    );
    lastEventAt = Date.now(); // report once, not every tick
    return;
  }
  autoRestarts++;
  lastEventAt = Date.now();
  console.warn(`session stalled after authentication — restarting the client (attempt ${autoRestarts})`);
  try {
    await client.destroy();
  } catch (e) {
    console.warn("destroy during watchdog restart failed:", e?.message);
  }
  client.initialize();
}, 30_000);

client.initialize();
const server = app.listen(PORT, () => {
  console.log(`WhatsApp bridge listening on http://localhost:${PORT}`);
  console.log(`session dir: ${path.resolve(DATA_PATH)}`);
  console.log(`chrome: ${CHROME_PATH || "puppeteer bundled build"}`);
  console.log(`inbound replies are forwarded to ${APP_INBOUND_URL}`);
  console.log(`pairing page auth: ${QR_PUBLIC ? "PUBLIC (QR_PUBLIC=true)" : "token required"}`);
});

/**
 * Graceful shutdown. The auth state is flushed to disk on destroy(); exiting
 * hard (reboot, `systemctl restart`, host redeploy) without it can leave a
 * half-written session that needs a fresh QR scan.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — closing the WhatsApp session cleanly…`);
  const forceExit = setTimeout(() => process.exit(0), 15_000);
  try {
    await client.destroy();
  } catch (e) {
    console.warn("client.destroy during shutdown failed:", e?.message);
  }
  server.close();
  clearTimeout(forceExit);
  console.log("shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
