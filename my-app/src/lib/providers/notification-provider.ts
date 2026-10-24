/**
 * Provider-independent notification provider seam (Phase 7).
 *
 * Server-only. All credentials for any future real provider MUST live in
 * server-side env vars — never in client code, logs, or URLs.
 *
 * Active provider resolution:
 *  · "mock" (default): records simulated attempts, delivers nothing.
 *  · "whatsappWeb": set automatically when WHATSAPP_BOT_URL + WHATSAPP_BOT_TOKEN
 *    are both present (see src/lib/config/notifications.ts). Sends through the
 *    free local whatsapp-web.js bridge — note Meta has no published humanitarian
 *    exception for blood-donation content, so the owner accepts the risk that
 *    WhatsApp may restrict the paired number. Pair a dedicated number, never a
 *    personal one.
 */
import "server-only";
import crypto from "node:crypto";
import { NOTIFICATION_CONFIG } from "@/src/lib/config/notifications";
import { whatsappWebProvider } from "@/src/lib/providers/whatsapp-web";

export type OutboundMessage = {
  outboxId: string;
  requestId: string | null;
  recipientId: string;
  recipientPhone: string | null; // resolved at send time by real providers
  messageType: string;           // e.g. "match_action" — no message content persisted
};

export type SendOutcome =
  | { accepted: true; reference: string; simulated: boolean }
  | { accepted: false; reason: string; simulated: boolean };

export interface NotificationProvider {
  readonly name: string;
  /** Health check for monitoring dashboards. */
  healthCheck(): Promise<{ ok: boolean; mode: string; detail?: string }>;
  /** Attempt one send. MUST record the attempt durably. */
  send(msg: OutboundMessage): Promise<SendOutcome>;
}

/**
 * Mock development provider: records simulated attempts, delivers nothing.
 * Its reference is explicitly namespaced "mock-" so no code path can later
 * claim a real delivery.
 */
export const mockProvider: NotificationProvider = {
  name: "mock",
  async healthCheck() {
    return { ok: true, mode: "mock (no real messages are ever sent)" };
  },
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    // Simulated provider reference — the "mock-" prefix is load-bearing:
    // complete_outbox_item rejects 'delivered' without a real reference, and
    // this provider always reports simulated=true.
    const reference = `mock-${msg.messageType}-${crypto.randomUUID()}`;
    return { accepted: true, reference, simulated: true };
  },
};

export function getProvider(): NotificationProvider {
  // "whatsappWeb" is active only when BOTH env vars are set (gated in
  // config/notifications.ts). Anything unknown falls back to mock — never to
  // a real network call by accident.
  if (NOTIFICATION_CONFIG.PROVIDER === "whatsappWeb") return whatsappWebProvider;
  return mockProvider;
}
