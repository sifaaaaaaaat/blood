import "server-only";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

/**
 * Phase 10 moderation service.
 *
 * AUTHORIZATION MODEL:
 *  · The route handler resolves the session server-side (getAuthUser) and
 *    passes the user's OWN cookie session into these calls. Every mutating
 *    RPC re-verifies admin/moderator status inside Postgres via auth.uid()
 *    — a forged or stale cookie cannot trick the DB, and the app-level
 *    checks here are convenience refusals only.
 *  · Read paths (queues, metrics, delivery failures) run through the
 *    service-role client whose underlying tables are invisible to every
 *    authenticated role over PostgREST (no policies + revoked grants), so
 *    the only access is this session-gated service path.
 *  · Least privilege: moderator capabilities are a strict subset of admin
 *    capabilities (no role grants, no settings, no reinstatements). No read
 *    path returns contact data; profile inspection returns a duplicate-
 *    phone CORRELATION FLAG, never the number.
 */

export type CookieProvider = () => Promise<{ name: string; value: string }[]>;

type DbError = { message: string } | null;
type RpcResult = { data: unknown; error: DbError };
type SingleRow = { data: unknown; error: DbError };
type TableRef = {
  select(cols: string): {
    eq(col: string, val: string | number): {
      order(col: string, opts?: { ascending?: boolean }): {
        limit(n: number): PromiseLike<SingleRow>;
      };
      limit(n: number): PromiseLike<SingleRow>;
    };
    order(col: string, opts?: { ascending?: boolean }): {
      limit(n: number): PromiseLike<SingleRow>;
    };
    limit(n: number): PromiseLike<SingleRow>;
  };
  insert(row: unknown): PromiseLike<{ data: unknown; error: DbError }>;
};
type SupabaseLike = {
  from(table: string): TableRef;
  rpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult>;
};

// The user's own session client — required for staff RPC calls because the
// RPCs authorize on auth.uid() from the JWT, never on app-level flags.
async function getSessionClient(getCookies: CookieProvider): Promise<SupabaseLike> {
  const { createUserClient } = await import("@/src/lib/db");
  return (await createUserClient(getCookies)) as unknown as SupabaseLike;
}
// Server-role client: reads on server-only tables blocked to all roles.
async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

const rpcRow = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Capability helpers — app-level convenience refusals (the DB re-verifies)
// ---------------------------------------------------------------------------

const isStaff = (auth: AuthUser) => auth.isAdmin || auth.isModerator;

function refusedWhenCannot(auth: AuthUser, need: "staff" | "admin"): Result<never> | null {
  if (need === "admin" && !auth.isAdmin) return err("forbidden", "admin only");
  if (need === "staff" && !isStaff(auth)) return err("forbidden", "staff only");
  return null;
}

async function staffRpc(
  getCookies: CookieProvider,
  fn: string,
  args: Record<string, unknown>
): Promise<Result<unknown>> {
  const client = await getSessionClient(getCookies);
  const { data, error } = await client.rpc(fn, args);
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) ?? "refused");
  return { ok: true, data: row };
}

// ---------------------------------------------------------------------------
// User-facing abuse reports
// ---------------------------------------------------------------------------

export const ABUSE_TARGET_TYPES = ["blood_request", "donor_profile", "requester_profile", "in_app_contact", "other"] as const;
export const ABUSE_CATEGORIES = ["spam", "harassment", "fake_profile", "suspicious_request", "contact_abuse", "other"] as const;

export async function createAbuseReport(
  getCookies: CookieProvider,
  auth: AuthUser,
  input: { targetType: string; targetId?: string | null; category: string; detail?: string }
): Promise<Result<{ id: string }>> {
  if (!ABUSE_TARGET_TYPES.includes(input.targetType as never)) {
    return err("validation_error", "unknown target type");
  }
  if (!ABUSE_CATEGORIES.includes(input.category as never)) {
    return err("validation_error", "unknown category");
  }
  const client = await getSessionClient(getCookies);

  // Server-side per-account daily cap (account-scoped only — no device
  // fingerprints, no IP data; see platform_settings rate_limits).
  const bump = await client.rpc("bump_abuse_counter", { p_subject: auth.id, p_scope: "abuse_report" });
  if (bump.error) return err("db_error", bump.error.message);
  const bumpRow = (Array.isArray(bump.data) ? bump.data[0] : bump.data) as { allowed: boolean } | null;
  if (!bumpRow?.allowed) {
    return err("rate_limited", "report limit reached for today; your reports are queued for review");
  }

  const { error } = await client.from("abuse_reports").insert({
    reporter_id: auth.id,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    category: input.category,
    detail: input.detail ?? null,
  });
  if (error) return err("db_error", error.message);
  return { ok: true, data: { id: "created" } };
}

export async function listMyAbuseReports(
  getCookies: CookieProvider,
  auth: AuthUser
): Promise<Result<unknown>> {
  const client = await getSessionClient(getCookies);
  const { data, error } = await client
    .from("abuse_reports")
    .select("id, target_type, target_id, category, status, resolution_note, created_at")
    .eq("reporter_id", auth.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Staff queue + sanitized reads (service-role client; server-only tables)
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ["open", "reviewing", "actioned", "dismissed"];

export async function listAbuseReports(status?: string): Promise<Result<unknown>> {
  const svc = await getService();
  if (status && OPEN_STATUSES.includes(status)) {
    const { data, error } = await svc
      .from("abuse_reports")
      .select("id, reporter_id, target_type, target_id, category, status, handled_by, handled_at, resolution_note, created_at")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return err("db_error", error.message);
    return { ok: true, data };
  }
  const { data, error } = await svc
    .from("abuse_reports")
    .select("id, reporter_id, target_type, target_id, category, status, handled_by, handled_at, resolution_note, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

/**
 * Delivery-failure inspection: minimal operational fields ONLY.
 * recipient_phone (and message content) are deliberately excluded — no
 * contact data moves through inspection endpoints.
 */
export async function listDeliveryFailures(limit = 50): Promise<Result<unknown>> {
  const svc = await getService();
  const { data, error } = await svc
    .from("notification_outbox")
    .select("id, request_id, recipient_id, provider, message_type, attempts, failure_reason, created_at, completed_at")
    .eq("status", "failed")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

export async function listDisabledAccounts(): Promise<Result<unknown>> {
  const svc = await getService();
  const { data, error } = await svc
    .from("account_status")
    .select("user_id, status, disabled_at, reason, review_requested_at, review_note, resolved_at")
    .eq("status", "disabled")
    .order("disabled_at", { ascending: false })
    .limit(100);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

export async function readSettings(): Promise<Result<unknown>> {
  const svc = await getService();
  const { data, error } = await svc
    .from("platform_settings")
    .select("key, value, category, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

/**
 * Abuse metrics: aggregate/ids only. Top counters are account ids+counts —
 * never names, phones or freeform personal data.
 */
export async function abuseMetrics(): Promise<Result<{
  openReports: number;
  reviewingReports: number;
  disabledAccounts: number;
  failedSends: number;
  topCountersToday: unknown;
}>> {
  const svc = await getService();

  const one = await svc.from("abuse_reports")
    .select("status")
    .eq("status", "open")
    .limit(1000);
  const two = await svc.from("abuse_reports")
    .select("status")
    .eq("status", "reviewing")
    .limit(1000);
  const disabled = await svc.from("account_status")
    .select("status")
    .eq("status", "disabled")
    .limit(1000);
  const failed = await svc.from("notification_outbox")
    .select("id")
    .eq("status", "failed")
    .limit(1000);
  const counters = await svc.from("abuse_counters")
    .select("subject_id, scope, count")
    .eq("scope", "candidate_list")
    .order("count", { ascending: false })
    .limit(20);

  for (const q of [one, two, disabled, failed, counters]) {
    if (q && q.error) return err("db_error", q.error.message);
  }

  return {
    ok: true,
    data: {
      openReports: (Array.isArray(one?.data) ? one.data.length : 0),
      reviewingReports: (Array.isArray(two?.data) ? two.data.length : 0),
      disabledAccounts: (Array.isArray(disabled?.data) ? disabled.data.length : 0),
      failedSends: (Array.isArray(failed?.data) ? failed.data.length : 0),
      topCountersToday: counters?.data ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Staff mutations — each one re-verified inside its Postgres function
// ---------------------------------------------------------------------------

export async function reviewAbuseReport(
  getCookies: CookieProvider,
  auth: AuthUser,
  reportId: string,
  decision: "reviewing" | "actioned" | "dismissed",
  resolutionNote: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "staff");
  if (pre) return pre;
  return staffRpc(getCookies, "mod_review_abuse_report", {
    p_report: reportId,
    p_decision: decision,
    p_resolution_note: resolutionNote,
  });
}

export async function reviewRequest(
  getCookies: CookieProvider,
  auth: AuthUser,
  requestId: string,
  action: "flag" | "clear" | "cancel",
  note: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "staff");
  if (pre) return pre;
  return staffRpc(getCookies, "mod_review_request", {
    p_request: requestId,
    p_action: action,
    p_note: note,
  });
}

export async function disableAccount(
  getCookies: CookieProvider,
  auth: AuthUser,
  userId: string,
  reason: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "staff");
  if (pre) return pre;
  return staffRpc(getCookies, "mod_disable_account", {
    p_user: userId,
    p_reason: reason,
  });
}

/** Admin-only: the review decision on a disabled account. */
export async function reviewDisabledAccount(
  getCookies: CookieProvider,
  auth: AuthUser,
  userId: string,
  decision: "reinstate" | "confirm",
  note: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "admin");
  if (pre) return pre;
  return staffRpc(getCookies, "admin_review_disabled_account", {
    p_user: userId,
    p_decision: decision,
    p_note: note,
  });
}

export async function grantModerator(
  getCookies: CookieProvider,
  auth: AuthUser,
  userId: string,
  note?: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "admin");
  if (pre) return pre;
  return staffRpc(getCookies, "admin_grant_moderator", { p_user: userId, p_note: note ?? null });
}

export async function revokeModerator(
  getCookies: CookieProvider,
  auth: AuthUser,
  userId: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "admin");
  if (pre) return pre;
  return staffRpc(getCookies, "admin_revoke_moderator", { p_user: userId });
}

/** Admin-only: non-clinical settings. Category is guarded inside the RPC. */
export async function setSetting(
  getCookies: CookieProvider,
  auth: AuthUser,
  key: string,
  // JSON scalar only: number | string | boolean (checked by the RPC too).
  value: number | string | boolean,
  category: "rate_limits" | "moderation" | "operational",
  note?: string
): Promise<Result<unknown>> {
  const pre = refusedWhenCannot(auth, "admin");
  if (pre) return pre;
  // Defense in depth mirrors the RPC's own jsonb scalar check: only scalars
  // may be configured (objects/arrays/null are refused before any DB call).
  const isScalar = typeof value === "number" || typeof value === "string" || typeof value === "boolean";
  if (!isScalar) {
    return err("validation_error", "value must be a scalar");
  }
  return staffRpc(getCookies, "admin_set_setting", {
    p_key: key,
    p_value: value,
    p_category: category,
    p_note: note ?? null,
  });
}

/** Staff profile inspection — sanitized fields + correlation flag only. */
export async function inspectProfile(
  getCookies: CookieProvider,
  auth: AuthUser,
  userId: string
): Promise<Result<Record<string, unknown>>> {
  const pre = refusedWhenCannot(auth, "staff");
  if (pre) return pre;
  const client = await getSessionClient(getCookies);
  const { data, error } = await client.rpc("mod_inspect_profile", { p_user: userId });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err(String(row?.message === "staff only" ? "forbidden" : "not_found"), String(row?.message) || "refused");

  // Defensive strip: even if the function shape changes, these will never be
  // surfaced to the app layer.
  const SAFE_KEYS = [
    "display_name", "blood_group", "birth_year", "is_donor", "is_requester",
    "availability", "is_phone_verified", "matches_other_verified_phone",
    "open_reports", "created_at",
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of SAFE_KEYS) out[k] = row[k] ?? null;
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// User self-service: appeal a disabled account
// ---------------------------------------------------------------------------

export async function requestAccountReview(
  getCookies: CookieProvider,
  auth: AuthUser
): Promise<Result<unknown>> {
  return staffRpc(getCookies, "account_request_review", {});
}
