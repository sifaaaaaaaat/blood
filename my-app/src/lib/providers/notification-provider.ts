/**
 * Provider-independent notification provider seam (Phase 7).
 *
 * Server-only. All credentials for any future real provider MUST live in
 * server-side env vars — never in client code, logs, or URLs.
 *
 * The WhatsApp Business integration is deliberately NOT implemented: Meta's
 * current policy restricts "body parts or fluids" and its violations examples
 * name blood-donation centers, with no clear humanitarian exception published.
 * Until Meta or an authorized provider confirms this exact use case in a
 * use-case assessment, PROVIDER stays pinned to "mock" in
 * src/lib/config/notifications.ts. The seam below is ready for another
 * provider (e.g. transactional SMS) once the owner picks an alternative.
 */
import "server-only";
import crypto from "node:crypto";

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
  // Only the mock provider exists until the WhatsApp/alternative decision is
  // made by the owner. Unknown names fall back to mock — never to a real
  // network call by accident.
  return mockProvider;
}
