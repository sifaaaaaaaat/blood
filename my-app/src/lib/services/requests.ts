import "server-only";
import {
  bloodRequestCreateSchema,
  bloodRequestUpdateSchema,
  ALLOWED_TRANSITIONS,
  type RequestStatus,
} from "@/src/lib/validation/requests";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; field?: string; message: string };
const err = (code: string, message: string, field?: string): Result<never> => ({ ok: false, code, field, message });

type SupabaseLike = {
  from: (t: string) => PostgrestLike; // narrow client type kept local; see db.ts
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

type PostgrestLike = {
  upsert: (values: unknown, opts?: Record<string, unknown>) => PostgrestLike;
  select: (cols?: string) => PostgrestLike;
  update: (values: unknown) => PostgrestLike;
  eq: (col: string, val: unknown) => PostgrestLike;
  order: (col: string, opts?: { ascending?: boolean }) => PostgrestLike;
  limit: (n: number) => PostgrestLike;
  // Multi-step builder chains resolve when awaited via the thenable shape.
  maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  single: () => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  then: PostgrestThenable;
  catch?: unknown;
};
type PostgrestThenable = (
  onFulfilled?: (value: { data: unknown; error: { message: string; code?: string } | null }) => unknown,
  onRejected?: (reason: unknown) => unknown
) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

async function getUserClient(): Promise<SupabaseLike> {
  // Session-scoped client bound to the caller's cookies via next/headers
  // (route handlers + server components; RLS enforced).
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as SupabaseLike;
}

// ---------------------------------------------------------------------------
// Abuse protection: simple per-user rolling window (Phase 8+ may swap in
// Redis/local storage; interface stays the same).
// ---------------------------------------------------------------------------
const WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_PER_WINDOW = 5;
const buckets = new Map<string, number[]>();

export function checkCreateRate(user_id: string): boolean {
  const now = Date.now();
  const arr = (buckets.get(user_id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) return false;
  arr.push(now);
  buckets.set(user_id, arr);
  return true;
}

export async function createRequest(
  auth: AuthUser,
  input: unknown,
  opts?: { asDraft?: boolean }
) {
  const parsed = bloodRequestCreateSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message, i.path.join("."));
  }
  if (!checkCreateRate(auth.id)) {
    return err("rate_limited", "Too many requests in a short window; try again later");
  }
  const v = parsed.data;
  const supabase = await getUserClient();

  // Phase 10: durable, DB-side daily cap (server-verified, audited on trip)
  // backing the in-memory window with the account-scoped counter.
  const bump = await supabase.rpc("bump_abuse_counter", {
    p_subject: auth.id,
    p_scope: "request_create",
  });
  if (bump.error) return err("db_error", bump.error.message);
  const bumpRow = (Array.isArray(bump.data) ? bump.data[0] : bump.data) as
    { allowed: boolean } | null;
  if (!bumpRow?.allowed) {
    return err("rate_limited", "daily request limit reached; try again tomorrow");
  }

  // Idempotent insert relying on unique (creator_id, idempotency_key).
  // Replay probe: an existing row for this (creator, key) is returned as
  // existing:true WITHOUT a second write (the ON CONFLICT path below would
  // otherwise re-update the row and report it indistinguishably as new).
  const { data: replayed } = await supabase
    .from("blood_requests")
    .select("id, status")
    .eq("creator_id", auth.id)
    .eq("idempotency_key", v.idempotency_key)
    .single();
  if (replayed) return { ok: true as const, data: replayed, existing: true };

  // On conflict the existing row wins and we return it (no duplicate).
  const { data, error } = await supabase
    .from("blood_requests")
    .upsert(
      {
        creator_id: auth.id,
        blood_group: v.blood_group,
        location_id: v.location.upazila_id,
        location_text: v.location_text ?? v.hospital_name,
        urgency: v.urgency,
        units_needed: v.units_needed,
        required_by: v.required_by,
        request_notes: v.request_notes ?? null,
        consent_confirmed: true,
        contact_pref: v.contact_pref,
        status: (opts?.asDraft ? "draft" : "submitted") as RequestStatus,
        idempotency_key: v.idempotency_key,
      },
      { onConflict: "creator_id, idempotency_key", ignoreDuplicates: false }
    )
    .select("id, status")
    .single();

  if (error) {
    // Unique-violation surfaces as the previous request surviving: treat as success-with-existing
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await supabase
        .from("blood_requests")
        .select("id, status")
        .eq("creator_id", auth.id)
        .eq("idempotency_key", v.idempotency_key)
        .single();
      if (existing) return { ok: true as const, data: existing, existing: true };
    }
    return err("db_error", error.message);
  }

  // record the initial transition draft→submitted for audit history
  // (a draft creation is not a submission — nothing to record yet)
  const created = data as { id: string };
  if (!opts?.asDraft) {
    const svc = await getService();
    await svc.rpc("record_transition", { p_request_id: created.id, p_from: "draft", p_to: "submitted", p_reason: "created" });
  }

  return { ok: true as const, data, existing: false };
}

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

export async function listOwnRequests(auth: AuthUser) {
  const supabase = await getUserClient();
  const { data, error } = await supabase
    .from("blood_requests")
    .select("*")
    .eq("creator_id", auth.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return err("db_error", error.message);
  return { ok: true as const, data };
}

export async function getOwnRequest(auth: AuthUser, requestId: string) {
  const supabase = await getUserClient();
  const { data, error } = await supabase
    .from("blood_requests")
    .select("*")
    .eq("id", requestId)
    .eq("creator_id", auth.id)
    .maybeSingle();
  if (error) return err("db_error", error.message);
  if (!data) return err("not_found", "request not found (or it belongs to another user)");
  return { ok: true as const, data };
}

/** Owner-only update of permitted fields while the request is mutable. */
export async function updateOwnRequest(auth: AuthUser, requestId: string, input: unknown) {
  const parsed = bloodRequestUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message, i.path.join("."));
  }
  const supabase = await getUserClient();

  const statusCheck = await getOwnRequest(auth, requestId);
  if (!statusCheck.ok) return statusCheck;
  const current = statusCheck.data as { status: RequestStatus };
  if (!["draft", "submitted", "searching", "awaiting_responses"].includes(current.status)) {
    return err("invalid_state", `cannot edit a request in status '${current.status}'`);
  }

  const { data, error } = await supabase
    .from("blood_requests")
    .update(parsed.data)
    .eq("id", requestId)
    .eq("creator_id", auth.id)
    .select("id, status")
    .single();
  if (error) return err("db_error", error.message);
  return { ok: true as const, data };
}

/** Authoritative state transition — the ONLY path by which status ever changes. */
export async function transitionRequest(
  auth: AuthUser,
  requestId: string,
  to: RequestStatus,
  reason?: string
) {
  const supabase = await getUserClient();
  const current = await getOwnRequest(auth, requestId);
  if (!current.ok) return current;
  const row = current.data as { id: string; status: RequestStatus; creator_id: string };
  if (row.creator_id !== auth.id && !auth.isAdmin) {
    return err("forbidden", "cannot transition someone else's request");
  }
  const from = row.status;
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return err("invalid_transition", `cannot go from '${from}' to '${to}'`);
  }

  const { error: updErr } = await supabase
    .from("blood_requests")
    .update({ status: to, ...(isTerminal(to) ? { resolved_at: new Date().toISOString() } : {}) })
    .eq("id", requestId)
    .eq("creator_id", auth.id);
  if (updErr) return err("db_error", updErr.message);

  const svc = await getService();
  const { error: histErr } = await svc.rpc("record_transition", {
    p_request_id: requestId, p_from: from, p_to: to, p_reason: reason ?? null,
  });
  if (histErr) return err("audit_error", histErr.message);

  return { ok: true as const, data: { id: requestId, from, to } };
}

/** Status-history listing for a request. ID is validated before any SQL;
 * ownership is enforced (users: forbidden masks existence; admins: not_found). */
export async function listRequestTransitions(
  auth: AuthUser,
  requestId: string
): Promise<Result<unknown[]>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return err("validation_error", "invalid request id");
  }
  const supabase = await getUserClient();
  const { data, error } = await supabase
    .from("blood_requests")
    .select("id, creator_id")
    .eq("id", requestId)
    .maybeSingle();
  if (error) return err("db_error", error.message);
  const row = (data ?? null) as { id: string; creator_id: string } | null;
  if (!row) return err(auth.isAdmin ? "not_found" : "forbidden", "request not found");
  if (row.creator_id !== auth.id && !auth.isAdmin) {
    return err("forbidden", "not your request");
  }
  const { data: rows, error: histErr } = await supabase
    .from("request_transitions")
    .select("id, from_status, to_status, reason, actor_id, created_at")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (histErr) return err("db_error", histErr.message);
  return { ok: true, data: (rows ?? []) as unknown[] };
}

export function isTerminal(s: RequestStatus): boolean {
  return s === "fulfilled" || s === "cancelled" || s === "expired" || s === "flagged";
}
