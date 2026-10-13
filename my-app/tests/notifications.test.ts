import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db: capture RPCs and table ops.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResults: {} as Record<string, unknown>,
  // table -> data for maybeSingle lookups
  tableRow: {} as Record<string, unknown>,
  filters: [] as Array<{ table: string; col: string; val: string }>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  insertError: null as { message: string } | null,
  updates: [] as Array<{ table: string; cols: unknown; col: string; val: string }>,
  counts: {} as Record<string, number>,
}));

vi.mock("@/src/lib/db", () => {
  const makeTable = (name: string) => {
    const selectChain = {
      eq: (col: string, val: string | number) => {
        state.filters.push({ table: name, col, val: String(val) });
        return selectChain;
      },
      maybeSingle: () => Promise.resolve({ data: state.tableRow[name] ?? null }),
      single: () => Promise.resolve({ data: state.tableRow[name] ?? null }),
    };
    return {
      select: () => selectChain,
      eq: (col: string, val: string | number) => {
        state.filters.push({ table: name, col, val: String(val) });
        return Promise.resolve({ error: null });
      },
      insert: (row: unknown) => {
        state.inserts.push({ table: name, row });
        return Promise.resolve({ error: state.insertError });
      },
      update: (cols: unknown) => ({
        eq: (col: string, val: string | number) => {
          state.updates.push({ table: name, cols, col, val: String(val) });
          return Promise.resolve({ error: null });
        },
      }),
      count: () => ({
        eq: (col: string, val: string | number) => {
          state.filters.push({ table: name, col, val: String(val) });
          return Promise.resolve({ count: state.counts[String(val)] ?? 0, error: null });
        },
      }),
    };
  };
  const client = () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(
        (state.rpcResults[fn] ?? { data: null as unknown, error: null }) as never
      );
    },
    from: (name: string) => makeTable(name),
  });
  return {
    getServiceRoleClient: client,
    createUserClient: async () => client(),
  };
});

import { enqueueNotification, processOutbox, processDeliveryStatus, notificationHealth } from "@/src/lib/services/notifications";
import { mockProvider } from "@/src/lib/providers/notification-provider";
import { NOTIFICATION_CONFIG } from "@/src/lib/config/notifications";

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
  state.tableRow = {};
  state.filters = [];
  state.inserts = [];
  state.insertError = null;
  state.updates = [];
  state.counts = {};
});

// ---------------------------------------------------------------------------
// Mock provider sanity: it can NEVER claim to be a real send.
// ---------------------------------------------------------------------------
describe("mock provider", () => {
  it("always reports simulated=true with an explicit mock- reference", async () => {
    const outcome = await mockProvider.send({
      outboxId: "o1", requestId: "r1", recipientId: "d1", recipientPhone: null, messageType: "match_action",
    });
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    expect(outcome.simulated).toBe(true);
    expect(outcome.reference.startsWith("mock-")).toBe(true);
  });

  it("healthCheck advertises mock mode (never masquerades as live)", async () => {
    const h = await mockProvider.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.mode).toContain("mock");
  });
});

// ---------------------------------------------------------------------------
// Enqueue: idempotency + duplicate prevention
// ---------------------------------------------------------------------------
describe("enqueueNotification", () => {
  it("inserts with the caller idempotency key and config default provider", async () => {
    const res = await enqueueNotification({
      requestId: "r1", recipientId: "d1", messageType: "match_action", idempotencyKey: "match_action:m1:accept",
    });
    expect(res.ok).toBe(true);
    const row = state.inserts[0].row as Record<string, unknown>;
    expect(row.idempotency_key).toBe("match_action:m1:accept");
    expect(row.provider).toBe(NOTIFICATION_CONFIG.PROVIDER);
    expect(row.message_type).toBe("match_action");
    expect(state.inserts[0].table).toBe("notification_outbox");
  });

  it("treats duplicate idempotency key as success (created: false), not an error", async () => {
    state.insertError = { message: 'duplicate key value violates unique constraint "notification_outbox_idempotency_key_key"' };
    const res = await enqueueNotification({ requestId: "r1", recipientId: "d1", messageType: "x", idempotencyKey: "k" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.created).toBe(false);
  });

  it("never stores message content or recipient phone in the queue row", async () => {
    await enqueueNotification({ requestId: "r1", recipientId: "d1", messageType: "match_action", idempotencyKey: "k" });
    const row = state.inserts[0].row as Record<string, unknown>;
    expect(row.recipient_id).toBe("d1");
    expect(row.recipient_phone).toBeUndefined(); // not persisted by enqueue
    expect(Object.keys(row)).not.toContain("message_body");
  });
});

// ---------------------------------------------------------------------------
// Process sweep: relay to RPCs with correct outcome wiring
// ---------------------------------------------------------------------------
describe("processOutbox", () => {
  const claimed = [
    { id: "o1", request_id: "r1", recipient_id: "d1", recipient_phone: null, provider: "mock", message_type: "match_action", attempts: 1, simulated: false },
  ];

  it("claims with configured batch size and per-donor fairness limit", async () => {
    state.rpcResults.claim_outbox_batch = { data: claimed, error: null };
    state.rpcResults.complete_outbox_item = { data: "simulated_sent", error: null };
    const res = await processOutbox();
    expect(res.ok).toBe(true);
    const claim = state.rpcCalls.find((c) => c.fn === "claim_outbox_batch");
    expect(claim?.args?.p_limit).toBe(NOTIFICATION_CONFIG.BATCH_SIZE);
    expect(claim?.args?.p_per_recipient_limit).toBe(NOTIFICATION_CONFIG.PER_DONOR_PENDING_LIMIT);
  });

  it("completes a successful mock send as simulated_sent (never delivered)", async () => {
    state.rpcResults.claim_outbox_batch = { data: claimed, error: null };
    state.rpcResults.complete_outbox_item = { data: "simulated_sent", error: null };
    const res = await processOutbox();
    const complete = state.rpcCalls.find((c) => c.fn === "complete_outbox_item");
    expect(complete?.args?.p_outcome).toBe("accepted");
    expect(complete?.args?.p_simulated).toBe(true);
    expect(String(complete?.args?.p_provider_ref).startsWith("mock-")).toBe(true);
    if (res.ok) expect(res.data.simulatedSent).toBe(1);
  });

  it("applies exponential backoff: base * 2^(attempt-1)", async () => {
    state.rpcResults.claim_outbox_batch = { data: [{ ...claimed[0], attempts: 3 }], error: null };
    state.rpcResults.complete_outbox_item = { data: "retry_scheduled", error: null };
    await processOutbox();
    const complete = state.rpcCalls.find((c) => c.fn === "complete_outbox_item");
    expect(complete?.args?.p_backoff_minutes).toBe(NOTIFICATION_CONFIG.BACKOFF_BASE_MINUTES * 4);
  });

  it("passes the hard attempt cap and failure reasons through", async () => {
    state.rpcResults.claim_outbox_batch = { data: [ { ...claimed[0], attempts: NOTIFICATION_CONFIG.MAX_ATTEMPTS } ], error: null };
    state.rpcResults.complete_outbox_item = { data: "failed", error: null };
    const res = await processOutbox();
    const complete = state.rpcCalls.find((c) => c.fn === "complete_outbox_item");
    expect(complete?.args?.p_max_attempts).toBe(NOTIFICATION_CONFIG.MAX_ATTEMPTS);
    if (res.ok) expect(res.data.failed).toBe(1);
  });

  it("raises the repeated-failure monitoring signal each sweep", async () => {
    state.rpcResults.claim_outbox_batch = { data: claimed, error: null };
    state.rpcResults.complete_outbox_item = { data: "simulated_sent", error: null };
    await processOutbox();
    const alert = state.rpcCalls.find((c) => c.fn === "alert_repeated_failures");
    expect(alert?.args?.p_threshold).toBe(NOTIFICATION_CONFIG.REPEATED_FAILURE_ALERT_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Delivery-status processing: the simulated/real boundary
// ---------------------------------------------------------------------------
describe("processDeliveryStatus", () => {
  it("rejects real delivery status for simulated sends", async () => {
    state.tableRow.notification_outbox = { id: "o1", provider: "mock", status: "sending", simulated: true };
    const res = await processDeliveryStatus("mock-abc", "delivered");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_allowed");
  });

  it("a simulated row in a terminal state also freezes (replay no-op)", async () => {
    state.tableRow.notification_outbox = { id: "o1", provider: "mock", status: "simulated_sent", simulated: true };
    const res = await processDeliveryStatus("mock-abc", "delivered");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.applied).toBe(false);
  });

  it("unknown provider reference is not_found (no guessing)", async () => {
    state.tableRow.notification_outbox = null;
    const res = await processDeliveryStatus("ref-unknown", "delivered");
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(res.ok).toBe(false);
  });

  it("terminal rows freeze — callback replays are no-ops", async () => {
    state.tableRow.notification_outbox = { id: "o1", provider: "x", status: "delivered", simulated: false };
    const res = await processDeliveryStatus("ref", "delivered");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.applied).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("applies real delivered status by row id", async () => {
    state.tableRow.notification_outbox = { id: "o1", provider: "real", status: "sending", simulated: false };
    const res = await processDeliveryStatus("ref", "delivered");
    expect(res.ok).toBe(true);
    expect(state.updates[0].table).toBe("notification_outbox");
    expect((state.updates[0].cols as Record<string, unknown>).status).toBe("delivered");
    expect(state.updates[0].col).toBe("id");
    expect(state.updates[0].val).toBe("o1");
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
describe("notificationHealth", () => {
  it("reports provider mode and per-status queue depth", async () => {
    Object.assign(state.counts, { queued: 2, sending: 1, failed: 0, delivered: 0, simulated_sent: 7 });
    const res = await notificationHealth();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.provider).toBe("mock");
      expect(res.data.mode).toContain("mock");
      expect(res.data.queued).toBe(2);
      expect(res.data.simulatedSent).toBe(7);
    }
  });
});
