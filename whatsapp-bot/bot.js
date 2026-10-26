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
 * Endpoints (all require header  x-bot-token: <same token as the app>):
 *   GET  /status  → { ready, paired, info }
 *   GET  /qr      → HTML page rendering the pairing QR (no auth: pairing time)
 *   POST /send    → { phone: "8801XXXXXXXXX", text: "..." }
 */
require("dotenv").config();
const express = require("express");
const crypto = require("node:crypto");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");

// Own env var only: the host shell may carry PORT=0, which would bind to a
// random/invalid port and make the bridge unreachable.
const PORT = Number(process.env.BRIDGE_PORT) || 3001;
const TOKEN = process.env.WHATSAPP_BOT_TOKEN || "";

if (!TOKEN) {
  console.error("WHATSAPP_BOT_TOKEN is missing — refusing to start (writes would be unauthenticated).");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "64kb" }));

let latestQr = null;
let ready = false;
let starting = true;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
  // Puppeteer may have to download its own Chromium; keep defaults for reliability.
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", async (qr) => {
  latestQr = qr;
  console.log("\n=== Scan this QR with WhatsApp → Linked devices → Link a device ===\n");
  console.log(qrcode.toString(qr, { small: true }));
  console.log("\n(or open http://localhost:" + PORT + "/qr in a browser)\n");
});

client.on("authenticated", () => console.log("[ev] authenticated"));
client.on("loading_screen", (pct, msg) => console.log(`[ev] loading_screen ${pct}% ${msg ?? ""}`));
client.on("loading_screen_failure", (err) => console.error("[ev] loading_screen FAILURE:", err));
client.on("remote_session_saved", () => console.log("[ev] remote_session_saved"));

client.on("ready", () => {
  ready = true;
  starting = false;
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

// Local-only pairing page: renders the live QR as an image.
app.get("/qr", async (_req, res) => {
  if (!latestQr) {
    return res.status(404).send(ready ? "<h1>Already paired ✅</h1>" : "<h1>No QR yet — still starting, refresh in a few seconds…</h1>");
  }
  const dataUrl = await qrcode.toDataURL(latestQr);
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding-top:40px">
    <h2>RoktoSathi WhatsApp bot — pair your number</h2>
    <p>WhatsApp app → Settings → Linked devices → Link a device</p>
    <img src="${dataUrl}" width="320" height="320"/>
    <p>Refresh this page if it expires.</p></body></html>`);
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

client.initialize();
app.listen(PORT, () => console.log(`WhatsApp bridge listening on http://localhost:${PORT}`));
