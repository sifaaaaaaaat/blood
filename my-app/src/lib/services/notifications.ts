import "server-only";
import { NOTIFICATION_CONFIG } from "@/src/lib/config/notifications";
import { getProvider } from "@/src/lib/providers/notification-provider";
import type { SendOutcome } from "@/src/lib/providers/notification-provider";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type DbError = { message: string };
type RpcResult = { data: unknown; error: DbError | null };
type WriteResult = { error: DbError | null };
type SingleRow = { data: unknown };

interface SelectChain {
  eq(col: string, val: string | number): SelectChain;
  maybeSingle(): PromiseLike<SingleRow>;
  single(): PromiseLike<SingleRow>;
}
interface CountChain {
  eq(col: string, val: string | number): PromiseLike<CountRow>;
}
type CountRow = { count: number | null; error: DbError | null };
interface UpdateChain {
  eq(col: string, val: string): PromiseLike<WriteResult>;
}
interface TableRef {
  select(cols: string): SelectChain;
  insert(row: Record<string, unknown>): PromiseLike<WriteResult>;
  update(row: Record<string, unknown>): UpdateChain;
  count(): CountChain;
}
interface SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult>;
  from(table: string): TableRef;
}

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

export type EnqueueInput = {
  requestId: string | null;
  recipientId: string;
  /** e.g. "match_action" — message TYPE only; content is never persisted. */
  messageType: string;
  /** Caller-supplied idempotency key, e.g. "match_action:{matchId}:{action}". */
  idempotencyKey: string;
  /** Only rows with a matching provider are processed. */
  provider?: string;
};

/**
 * Enqueue a notification. Idempotent: duplicate idempotency keys are a no-op
 * (duplicate PREVENTION at the durable-queue layer). Consent is NOT checked
 * here — it is re-checked at send time by claim_outbox_batch, so a donor
 * revoking consent between enqueue and send is still honored.
 */
export async function enqueueNotification(input: EnqueueInput): Promise<Result<{ created: boolean }>> {
  const svc = await getService();
  // ignoreDuplicates => ON CONFLICT (idempotency_key) DO NOTHING
  const { error } = await svc.from("notification_outbox").insert({
    idempotency_key: input.idempotencyKey,
    request_id: input.requestId,
    recipient_id: input.recipientId,
    provider: input.provider ?? NOTIFICATION_CONFIG.PROVIDER,
    message_type: input.messageType,
    expires_at: new Date(Date.now() + NOTIFICATION_CONFIG.STALE_TTL_HOURS * 3_600_000).toISOString(),
  });
  if (error) {
    // Unique-violation means the notification already exists — that is
    // success for an idempotent enqueue, not an error.
    if (/duplicate|unique/i.test(error.message)) return { ok: true, data: { created: false } };
    return err("db_error", error.message);
  }
  return { ok: true, data: { created: true } };
}

type ClaimedRow = {
  id: string; request_id: string | null; recipient_id: string;
  recipient_phone: string | null; provider: string; message_type: string;
  attempts: number; simulated: boolean;
};

/**
 * Process one batch. Idempotent + race-free by construction:
 *  · claim_outbox_batch claims with FOR UPDATE SKIP LOCKED and applies the
 *    cancellation + consent + staleness + per-donor-limit gates in SQL;
 *  · each item transitions queued → sending → terminal in complete_outbox_item,
 *    which is idempotent (re-running the sweep cannot double-send or
 *    double-transition).
 * Backoff = base * 2^(attempt-1), bounded by MAX_ATTEMPTS.
 */
export type ProcessSummary = {
  claimed: number;
  simulatedSent: number;
  delivered: number;
  failed: number;
  retryScheduled: number;
  noop: number;
};

export async function processOutbox(
  limit: number = NOTIFICATION_CONFIG.BATCH_SIZE
): Promise<Result<ProcessSummary>> {
  const svc = await getService();
  const provider = getProvider();

  const { data: claimedData, error: claimErr } = await svc.rpc("claim_outbox_batch", {
    p_limit: limit,
    p_per_recipient_limit: NOTIFICATION_CONFIG.PER_DONOR_PENDING_LIMIT,
  });
  if (claimErr) return err("db_error", claimErr.message);
  const claimed = (Array.isArray(claimedData) ? claimedData : []) as ClaimedRow[];

  const summary: ProcessSummary = { claimed: claimed.length, simulatedSent: 0, delivered: 0, failed: 0, retryScheduled: 0, noop: 0 };

  for (const row of claimed) {
    const outcome: SendOutcome = await provider.send({
      outboxId: row.id,
      requestId: row.request_id,
      recipientId: row.recipient_id,
      recipientPhone: row.recipient_phone,
      messageType: row.message_type,
    });

    const backoffMinutes = NOTIFICATION_CONFIG.BACKOFF_BASE_MINUTES * 2 ** Math.max(0, (row.attempts ?? 1) - 1);
    const { data: result } = await svc.rpc("complete_outbox_item", {
      p_outbox_id: row.id,
      p_outcome: outcome.accepted ? "accepted" : "failed",
      p_simulated: outcome.accepted ? outcome.simulated : outcome.simulated,
      p_provider_ref: outcome.accepted ? outcome.reference : null,
      p_failure_reason: outcome.accepted ? null : outcome.reason,
      p_backoff_minutes: backoffMinutes,
      p_max_attempts: NOTIFICATION_CONFIG.MAX_ATTEMPTS,
    });
    switch (result) {
      case "simulated_sent": summary.simulatedSent++; break;
      case "delivered": summary.delivered++; break; // impossible for mock; counted defensively
      case "failed": summary.failed++; break;
      case "retry_scheduled": summary.retryScheduled++; break;
      default: summary.noop++;
    }
  }

  // Repeated-failure monitoring signal for dashboards/alerts.
  await svc.rpc("alert_repeated_failures", {
    p_threshold: NOTIFICATION_CONFIG.REPEATED_FAILURE_ALERT_THRESHOLD,
  });

  return { ok: true, data: summary };
}

/**
 * Delivery-status processing (provider callbacks). A real provider reports
 * final delivery states; this validates them against the row so that:
 *  · simulated rows can NEVER be upgraded to 'delivered',
 *  · terminal rows are frozen (idempotent callback replays are no-ops).
 */
export async function processDeliveryStatus(
  providerRef: string,
  state: "delivered" | "failed",
  sanitizedReason?: string
): Promise<Result<{ applied: boolean; status: string }>> {
  const svc = await getService();
  const { data } = await svc
    .from("notification_outbox")
    .select("id, provider, status, simulated")
    .eq("provider_ref", providerRef)
    .maybeSingle();
  if (!data) return err("not_found", "unknown provider reference");
  const row = data as { id: string; provider: string; status: string; simulated: boolean };

  if (["delivered", "simulated_sent", "failed", "expired", "skipped_consent", "skipped_cancelled"].includes(row.status)) {
    return { ok: true, data: { applied: false, status: row.status } }; // terminal already — replay is a no-op
  }
  if (row.simulated) {
    // Mock sends must never be reported as real message delivery.
    return err("not_allowed", "simulated sends cannot receive real delivery status");
  }
  const { error } = await svc.from("notification_outbox").update({
    status: state,
    completed_at: new Date().toISOString(),
    failure_reason: sanitizedReason ?? null,
  }).eq("id", row.id);
  if (error) return err("db_error", error.message);
  return { ok: true, data: { applied: true, status: state } };
}

/** Health check: provider liveness + queue depth signals. */
export async function notificationHealth(): Promise<Result<{
  provider: string; providerOk: boolean; mode: string;
  queued: number; sending: number; failed: number; delivered: number; simulatedSent: number;
}>> {
  const svc = await getService();
  const provider = getProvider();
  const health = await provider.healthCheck();

  const depth: Record<string, number> = {};
  for (const status of ["queued", "sending", "failed", "delivered", "simulated_sent"]) {
    const { count } = await svc.from("notification_outbox").count().eq("status", status);
    depth[status] = count ?? 0;
  }
  return {
    ok: true,
    data: {
      provider: provider.name, providerOk: health.ok, mode: health.mode,
      queued: depth.queued, sending: depth.sending, failed: depth.failed,
      delivered: depth.delivered, simulatedSent: depth.simulated_sent,
    },
  };
}
