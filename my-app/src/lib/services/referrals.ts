import "server-only";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

/**
 * Phase 12 — referral attribution (community-recognition ledger ONLY).
 *
 * No money, no clinical weight, no matching influence: a referral changes no
 * scoring, no eligibility and no priority anywhere in the platform. Codes are
 * issued/get-or-created server-side via the DB function; redemption is
 * idempotent per (code, user) and self-redemption is refused in SQL.
 */

type DbError = { message: string } | null;

type ClientLike = {
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: DbError }>;
  from(table: string): {
    select(cols?: string): {
      eq(c: string, v: unknown): PromiseLike<{ data: unknown; error: DbError }>;
    };
    insert(v: unknown): PromiseLike<{ data: unknown; error: DbError }>;
  };
};

async function getAuthed(): Promise<ClientLike> {
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as ClientLike;
}

export type ReferralSummary = { code: string | null; referralCount: number };

/** The signed-in user's code (issued on first call) + redemption count. */
export async function myReferralSummary(): Promise<Result<ReferralSummary>> {
  const client = await getAuthed();
  const { data, error } = (await client.rpc("referral_issue_code")) as {
    data: unknown;
    error: DbError | null;
  };
  if (error) {
    const msg = error?.message ?? "";
    if (/permission denied|row-level/i.test(msg)) return err("forbidden", msg);
    return err("db_error", msg);
  }
  const code = typeof data === "string" ? data : null;
  if (!code) return err("db_error", "no code issued (not signed in?)");

  // referral_uses.code_id is a uuid; the RPC returns the TEXT code, so resolve
  // the owning row's id first. RLS: the owner can read their own code row; if
  // it isn't readable yet (eventual consistency), redemptions count as 0 —
  // the code itself was already issued successfully.
  const { data: codeRow, error: codeErr } = (await client
    .from("referral_codes")
    .select("id")
    .eq("code", code)) as unknown as {
    data: { id: string }[] | null;
    error: DbError | null;
  };
  if (codeErr) return err("db_error", codeErr.message);
  const codeId = codeRow?.[0]?.id;
  if (!codeId) return { ok: true, data: { code, referralCount: 0 } };

  const { data: countRows, error: cntErr } = (await client
    .from("referral_uses")
    .select("used_by_id")
    .eq("code_id", codeId)) as unknown as {
    data: unknown;
    error: DbError | null;
  };
  if (cntErr) return err("db_error", cntErr!.message);
  // RLS: the owner sees every use of their code; anyone else sees their own
  // redemptions — but this path only reads the OWNER's own code.
  const count = Array.isArray(countRows) ? countRows.length : 0;
  return { ok: true, data: { code, referralCount: count } };
}

export type RedeemOutcome = {
  redeemed: boolean;
  referralCount: number;
};

/** Redeem a code posted by the user; honest reasons for refusals. */
export async function redeemCode(auth: AuthUser, rawCode: unknown): Promise<Result<RedeemOutcome>> {
  if (typeof rawCode !== "string" || !/^[A-Za-z0-9-]{4,24}$/.test(rawCode.trim())) {
    return err("validation_error", "invalid referral code");
  }
  const client = await getAuthed();
  const { data, error } = (await client.rpc("referral_redeem", { p_code: rawCode.trim() })) as {
    data: unknown;
    error: DbError | null;
  };
  if (error) {
    const msg = error?.message ?? "";
    if (/not signed in/i.test(msg)) return err("unauthorized", msg);
    return err("db_error", msg);
  }
  const row = (Array.isArray(data) ? data[0] : data) as {
    ok: boolean;
    reason?: string;
    redeemed?: boolean;
    referral_count?: number;
  } | null;
  if (!row) return err("db_error", "no result from referral_redeem");
  if (!row.ok) return err("refused", row.reason ?? "referral cannot be redeemed");
  return {
    ok: true,
    data: { redeemed: row.redeemed === true, referralCount: Number(row.referral_count ?? 0) },
  };
}
