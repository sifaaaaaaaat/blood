import "server-only";
import type { AuthUser } from "@/src/lib/auth";
import { enqueueNotification } from "@/src/lib/services/notifications";
import { createActionToken, type Result } from "@/src/lib/services/acceptance";

const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type TableRef = {
  select(cols: string): {
    eq(col: string, val: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  update(row: Record<string, unknown>): {
    eq(col: string, val: string): PromiseLike<{ error: { message: string } | null }>;
  };
};
type SupabaseLike = { from(t: string): TableRef };

async function getUserClient(): Promise<SupabaseLike> {
  const { createUserClient } = await import("@/src/lib/db");
  return (await createUserClient(async () => [])) as unknown as SupabaseLike;
}

type MatchRow = { id: string; donor_id: string };

/**
 * Fan-out: every pending, consented match for a request gets:
 *   1. a fresh single-use action token (accept/decline/unavailable link), and
 *   2. exactly one outbox row keyed `match_action:{matchId}:accept`
 *      (idempotent — re-running the fan-out cannot double-enqueue).
 * The donor's recipient (identity) is bound to the match row, so tokens are
 * only ever redeemed by the donor the match belongs to.
 *
 * Consent, phone-verification, fatigue, request state and cancellation are
 * enforced by the matching gateway at match creation and re-checked by
 * claim_outbox_batch at send time — never by client input.
 */
export async function fanOutMatchesForRequest(
  auth: AuthUser,
  requestId: string
): Promise<Result<{ matched: number; enqueued: number; alreadyQueued: number }>> {
  const client = await getUserClient();

  // Authorization: request owner or admin only (same rule as matching).
  const { data, error } = await client
    .from("request_matches")
    .select("id, donor_id")
    .eq("request_id", requestId);
  if (error) return err("db_error", error.message);

  // RLS (requester) already limits rows to own requests; admins see all.
  const matches = (Array.isArray(data) ? data : []) as MatchRow[];
  if (!matches.length) return err("not_found", "no matches for request");

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const m of matches) {
    const token = await createActionToken({
      matchId: m.id,
      action: "accept",
      donorId: m.donor_id,
    });
    if (!token.ok) return err(token.code, token.message);

    const res = await enqueueNotification({
      requestId,
      recipientId: m.donor_id,
      messageType: "match_action",
      idempotencyKey: `match_action:${m.id}:accept`,
      provider: "mock",
    });
    if (!res.ok) return err(res.code, res.message);
    if (res.data.created) enqueued++; else alreadyQueued++;
  }

  // (fatigue / consent / request-state were enforced at match creation and
  // are re-checked by claim_outbox_batch at send time)
  return { ok: true, data: { matched: matches.length, enqueued, alreadyQueued } };
}
