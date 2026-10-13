import "server-only";
import crypto from "node:crypto";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type DbError = { message: string };
type RpcResult = { data: unknown; error: DbError | null };
type WriteResult = { error: DbError | null };
type SingleRow = { data: unknown };

interface SelectChain {
  eq(col: string, val: string | number): SelectChain;
  maybeSingle(): PromiseLike<SingleRow>;
}
interface UpdateChain {
  eq(col: string, val: string): PromiseLike<WriteResult>;
}
interface TableRef {
  select(cols: string): SelectChain;
  insert(row: Record<string, unknown>): PromiseLike<WriteResult>;
  update(row: Record<string, unknown>): UpdateChain;
}
interface SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult>;
  from(table: string): TableRef;
}

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Action tokens: create a single-use, short-lived token whose URL contains
 * only the opaque token — never personal data or secrets. Only the SHA-256
 * hash is stored; the raw value exists solely at link-generation time.
 */
export type ActionTokenInput = {
  matchId: string;
  action: "accept" | "decline" | "unavailable";
  donorId: string;
};
export type ActionToken = { token: string; expiresAt: string };

export async function createActionToken(input: ActionTokenInput): Promise<Result<ActionToken>> {
  const svc = await getService();

  const raw = crypto.randomBytes(32).toString("base64url");
  const hash = sha256(raw);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  // The donor is never stored in the token table: ownership is derived from
  // the match row itself at redemption time, so a leaked token cannot be
  // re-bound to another donor.
  const { error: insErr } = await svc.from("match_action_tokens").insert({
    token_hash: hash,
    match_id: input.matchId,
    action: input.action,
    expires_at: expiresAt,
  });
  if (insErr) return err("db_error", insErr.message);

  return { ok: true, data: { token: raw, expiresAt } };
}

/**
 * Redeem a token for a donor action. Single-use: the redemption marks the
 * token used. Expiry is checked server-side. Ownership binds to the donor on
 * the match row, verified inside the DB RPC as well.
 */
type TokenRow = { token_hash: string; match_id: string; action: string; expires_at: string; used_at: string | null };
type MatchRow = { donor_id: string; request_id: string };

export async function redeemActionToken(
  rawToken: string,
  actingDonor?: string // set when an authenticated donor responds in-app
): Promise<Result<{ matchId: string; status: string }>> {
  const svc = await getService();
  const hash = sha256(rawToken);

  // Token lookup by hash only (table is client-invisible; service role).
  const { data } = await svc
    .from("match_action_tokens")
    .select("token_hash, match_id, action, expires_at, used_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data) return err("token_invalid", "unknown or already used token");
  const tok = data as TokenRow;

  if (tok.used_at) return err("token_used", "token already used");
  if (new Date(tok.expires_at) < new Date()) return err("token_expired", "token expired");

  const { data: matchData } = await svc
    .from("request_matches")
    .select("donor_id, request_id")
    .eq("id", tok.match_id)
    .maybeSingle();
  if (!matchData) return err("token_invalid", "match missing");
  const donorId = (matchData as MatchRow).donor_id;

  // In-app redemption must come from the donor bound to the match.
  if (actingDonor && actingDonor !== donorId) return err("forbidden", "not your match");

  // Mark single-use BEFORE performing the action; if the action fails the
  // token still cannot be replayed by another user (defense in depth — the
  // RPC independently validates everything again).
  await svc.from("match_action_tokens").update({ used_at: new Date().toISOString() }).eq("token_hash", hash);

  const { data: res, error: resErr } = await svc.rpc("donor_respond_match", {
    p_match_id: tok.match_id,
    p_action: tok.action,
    p_donor: donorId,
    p_source: "action_token",
  });
  if (resErr) return err("db_error", resErr.message);
  const row = (Array.isArray(res) ? res[0] : res) as { ok: boolean; status: string | null; message: string | null };
  if (!row?.ok) return err("action_rejected", row?.message ?? "action failed");
  return { ok: true, data: { matchId: tok.match_id, status: row.status ?? "" } };
}

/** In-app donor action (authenticated user = donor). */
export async function donorAct(
  auth: AuthUser,
  matchId: string,
  action: "accept" | "decline" | "unavailable"
): Promise<Result<{ matchId: string; status: string }>> {
  const svc = await getService();
  const { data: res, error } = await svc.rpc("donor_respond_match", {
    p_match_id: matchId,
    p_action: action,
    p_donor: auth.id,
    p_source: "in_app",
  });
  if (error) return err("db_error", error.message);
  const row = (Array.isArray(res) ? res[0] : res) as { ok: boolean; status: string | null; message: string | null };
  if (!row?.ok) {
    const code = row?.message === "not your match" ? "forbidden" : "action_rejected";
    return err(code, row?.message ?? "action failed");
  }
  return { ok: true, data: { matchId, status: row.status ?? "" } };
}

/**
 * Contact reveal: allowed only for the request creator, only on their own
 * accepted, non-expired, non-cancelled match. Recheck happens inside the DB
 * function on EVERY call. Audit row written per reveal.
 */
export async function revealDonorContact(
  auth: AuthUser,
  requestId: string,
  donorId: string
): Promise<Result<{ phone: string }>> {
  const svc = await getService();
  const { data, error } = await svc.rpc("reveal_contact", {
    p_request_id: requestId,
    p_donor_id: donorId,
    p_requester: auth.id,
  });
  if (error) {
    const msg = error.message.toLowerCase();
    const code = msg.includes("only the request creator")
      ? "forbidden"
      : msg.includes("no such match")
        ? "not_found"
        : msg.includes("not accepted")
          ? "invalid_state"
          : msg.includes("cancelled")
            ? "request_cancelled"
            : msg.includes("expired")
              ? "match_expired"
              : msg.includes("not verified")
                ? "phone_unverified"
                : "db_error";
    return err(code, error.message);
  }
  return { ok: true, data: { phone: data as string } };
}

/** Outreach governor: stop routine outreach once enough donors accepted. */
export async function shouldStopOutreach(requestId: string, unitsNeeded: number): Promise<boolean> {
  const svc = await getService();
  const { data } = await svc.rpc("count_accepted_for_request", { p_request_id: requestId }).catch(() => ({ data: null }));
  const accepted = (data as number | null) ?? 0;
  return accepted >= unitsNeeded;
}
