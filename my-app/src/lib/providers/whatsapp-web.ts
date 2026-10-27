/**
 * whatsappWeb provider (Phase 7 seam).
 *
 * Sends by POSTing to a local whatsapp-web.js bridge (see /whatsapp-bot/bot.js).
 * The bridge is a long-lived process that keeps ONE WhatsApp session alive and
 * exposes a token-authenticated HTTP API. Unlike Meta's Cloud API this is free
 * but unofficial — the paired number can still be banned by WhatsApp, so pair
 * a dedicated number, not a personal one.
 *
 * Config (server-side env vars only — never in client code, logs, or URLs):
 *   WHATSAPP_BOT_URL      e.g. http://localhost:3001  (base URL of the bridge)
 *   WHATSAPP_BOT_TOKEN    shared secret; must match the bridge's env var
 * Presence of BOTH gates PROVIDER = "whatsappWeb" in config/notifications.ts.
 *
 * If the bridge is unreachable or returns 503 (not paired), send() fails and
 * the durable outbox applies its normal retry/backoff — the sweep never
 * crashes and never marks a row delivered that was not really sent.
 */
import "server-only";
import crypto from "node:crypto";

import type { NotificationProvider, OutboundMessage, SendOutcome } from "@/src/lib/providers/notification-provider";
import { composeMatchAsk } from "@/src/lib/services/whatsapp-messages";
import { fetchRequestMessageContext } from "@/src/lib/services/whatsapp-flow";

const BOT_URL = (process.env.WHATSAPP_BOT_URL ?? "").replace(/\/+$/, "");
const BOT_TOKEN = process.env.WHATSAPP_BOT_TOKEN ?? "";

function digitsOnly(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/[^0-9]/g, "");
  return /^[0-9]{8,15}$/.test(d) ? d : null;
}

export const whatsappWebProvider: NotificationProvider = {
  name: "whatsappWeb",

  async healthCheck() {
    if (!BOT_URL || !BOT_TOKEN) return { ok: false, mode: "whatsappWeb (env vars missing)" };
    try {
      const res = await fetch(`${BOT_URL}/status`, {
        headers: { "x-bot-token": BOT_TOKEN },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { ok: false, mode: `whatsappWeb (bridge HTTP ${res.status})` };
      const body = (await res.json()) as { ready?: boolean };
      return body.ready
        ? { ok: true, mode: "whatsappWeb (session paired and ready)" }
        : { ok: false, mode: "whatsappWeb (bridge up, session NOT paired — open /qr)" };
    } catch (e) {
      return { ok: false, mode: `whatsappWeb (bridge unreachable: ${(e as Error).message})` };
    }
  },

  async send(msg: OutboundMessage): Promise<SendOutcome> {
    const phone = digitsOnly(msg.recipientPhone);
    if (!phone) {
      return { accepted: false, reason: "no valid recipient phone on record", simulated: false };
    }
    if (!BOT_URL || !BOT_TOKEN) {
      return { accepted: false, reason: "WHATSAPP_BOT_URL/TOKEN not configured", simulated: false };
    }
    // Content is composed here, at send time (message templates never live in
    // the outbox and no content is persisted). The match ask carries the real
    // request facts, so it is rendered from the request row.
    const text = await renderMessage(msg.messageType, { requestId: msg.requestId });
    if (!text) {
      return { accepted: false, reason: `no template for message type '${msg.messageType}'`, simulated: false };
    }

    try {
      const res = await fetch(`${BOT_URL}/send`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bot-token": BOT_TOKEN },
        body: JSON.stringify({ phone, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const ref = (await res.json().catch(() => ({}))) as { id?: string };
        // Real reference — namespaces with "ww-" so complete_outbox_item can
        // treat it as a genuine (non-simulated) send. whatsapp-web.js leaves
        // the id empty for some chats (e.g. LID self-chats), so fall back to a
        // random id: a shared empty suffix would give every row the same
        // reference and make deliveries impossible to trace.
        const reference = `ww-${msg.messageType}-${ref.id || crypto.randomUUID()}`;
        return { accepted: true, reference, simulated: false };
      }
      const detail = await res.text().catch(() => "");
      return { accepted: false, reason: `bridge HTTP ${res.status}: ${detail.slice(0, 200)}`, simulated: false };
    } catch (e) {
      return { accepted: false, reason: `bridge unreachable: ${(e as Error).message}`, simulated: false };
    }
  },
};

/**
 * Message body per message_type. Content rules: no fabricated delivery, no
 * donor-PII in the body, and no medical eligibility claims.
 *
 * The match ask is the donor-facing card (blood group, units, place, urgency)
 * followed by the numbered reply options the conversation flow understands.
 */
async function renderMessage(messageType: string, ctx: { requestId: string | null }): Promise<string | null> {
  if (!messageType.startsWith("match_action")) return null;
  if (!ctx.requestId) return null;

  const request = await fetchRequestMessageContext(ctx.requestId);
  if (!request) return null;
  // Never re-ask for a request that is no longer open; the outbox sweep skips
  // these too, so this is a second, cheap guard.
  if (!["submitted", "searching", "awaiting_responses"].includes(request.status)) return null;

  return composeMatchAsk(request);
}

/** Preferred export: single getProvider covers both mock and whatsappWeb. */
export function getwhatsappWebProvider(): NotificationProvider {
  return whatsappWebProvider;
}

// crypto is used for the random fallback reference above.
void crypto;
