import "server-only";
import { MATCHING_CONFIG } from "@/src/lib/config/matching";
import { RECOVERY_CONFIG as recoveryCfg } from "@/src/lib/config/recovery";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

export type CandidateTier = 1 | 2 | 3 | 4;

/** Safe display fields ONLY — no phone, no coordinates, no address. */
export type Candidate = {
  donor_user_id: string;
  display_name: string;
  blood_group: string;
  upazila_name: string;
  district_name: string;
  availability: string;
  tier: CandidateTier;
};

type RpcResult = { data: unknown; error: { message: string } | null };
type SupabaseLike = {
  from(t: string): {
    select(cols: string): {
      eq(c: string, v: unknown): {
        maybeSingle(): PromiseLike<RpcResult>;
        order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<RpcResult> };
        limit(n: number): PromiseLike<RpcResult>;
      };
      order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<RpcResult> };
      limit(n: number): PromiseLike<RpcResult>;
    };
    upsert(
      rows: unknown,
      opts?: Record<string, unknown>
    ): PromiseLike<RpcResult>;
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
};

const UUID_RE = /^[0-9a-f-]{36}$/i;

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

async function getUserClient(): Promise<SupabaseLike> {
  // Authed session client (cookies via next/headers) — RLS scopes every read
  // to the signed-in user. An empty-cookie anon client would see nothing.
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as SupabaseLike;
}

export async function assertCanMatch(auth: AuthUser, requestId: string): Promise<Result<unknown>> {
  const client = await getUserClient();
  const { data, error } = await client
    .from("blood_requests")
    .select("id, creator_id, blood_group, location_id, status")
    .eq("id", requestId)
    .maybeSingle();

  const row = (data ?? null) as
    | { id: string; creator_id: string; blood_group: string; location_id: number; status: string }
    | null;
  if (error || !row) return err("not_found", "request not found");
  if (row.creator_id !== auth.id && !auth.isAdmin) return err("forbidden", "not your request");
  if (!["submitted", "searching", "awaiting_responses"].includes(row.status)) {
    return err("invalid_state", `matching not allowed in status '${row.status}'`);
  }
  return { ok: true, data: row };
}

/**
 * Server-side candidate SQL. ALL filtering runs in Postgres — the service
 * never pulls the donor table into the app and filters it in memory.
 * Column list is the safe display set (no phone, no coordinates, no notes).
 */
export function candidatesQuery(opts: {
  bloodGroup: string;
  upazilaId: number;
  scope: "same_upazila" | "neighbour_upazilas" | "same_district" | "adjacent_districts";
  districtId?: number;
  limit: number;
}): string {
  const { bloodGroup, upazilaId, scope, districtId, limit } = opts;
  const fatigueCutoff = new Date(
    Date.now() - MATCHING_CONFIG.FATIGUE_WINDOW_DAYS * 86_400_000
  ).toISOString();

  const baseCols = `
    dp.user_id            as donor_user_id,
    p.display_name        as display_name,
    dp.blood_group::text  as blood_group,
    u.name                as upazila_name,
    d.name                as district_name,
    dp.availability::text as availability`;

  const tierVal =
    scope === "same_upazila" ? 1 : scope === "neighbour_upazilas" ? 2 : scope === "same_district" ? 3 : 4;

  const scopeClause =
    scope === "same_upazila"
      ? `dp.upazila_id = ${upazilaId}`
      : scope === "neighbour_upazilas"
        ? `dp.upazila_id in (select neighbor_id from public.upazila_adjacency where upazila_id = ${upazilaId})`
        : scope === "same_district"
          ? `u.district_id = ${districtId} and dp.upazila_id <> ${upazilaId}`
          : `u.district_id in (select neighbor_id from public.district_adjacency where district_id = ${districtId})`;

  const sql = `
    select ${baseCols}, ${tierVal} as tier
      from public.donor_profiles dp
      join public.profiles p    on p.id = dp.user_id
      join public.upazilas u    on u.id = dp.upazila_id
      join public.districts d   on d.id = u.district_id
      join public.contact_numbers cn on cn.user_id = dp.user_id
     where dp.blood_group::text = '${bloodGroup.replace(/'/g, "''")}'
       and dp.availability = 'available'
       and (dp.paused_until is null or dp.paused_until <= now())
       and dp.notify_consent = true
       and cn.verified_at is not null
       -- Donation interval rule: a donor who gave blood within the last three
       -- months is not asked again (self-reported dates included). This is a
       -- rest-period rule, NOT a medical eligibility judgment.
       and (
         dp.last_donation_date is null
         or dp.last_donation_date <= current_date - interval '3 months'
       )
       -- Phase 8: donors under an (unlifted) administrative recovery hold are
       -- excluded from ordinary matching. Holds persist until the DONOR
       -- confirms availability after the configured period (expiry does not
       -- auto-restore matching), so checking lifted=false is correct.
       and not exists (
         select 1 from public.donor_recovery_holds hh
          where hh.donor_id = dp.user_id and hh.lifted = false
       )
       -- Phase 10: donors whose account is disabled/suspended by moderation
       -- are out of every candidate listing (DB-checked elsewhere too).
       and not exists (
         select 1 from public.account_status st
          where st.user_id = dp.user_id and st.status <> 'active'
       )
       and (${scopeClause})
       and (
         select count(*) from public.request_transitions rt
          join public.blood_requests r on r.id = rt.request_id
         where rt.actor_id = dp.user_id
           and rt.to_status = 'connected'
           and rt.created_at >= '${fatigueCutoff}'
       ) < ${MATCHING_CONFIG.FATIGUE_MAX_ENGAGEMENTS}
       -- Phase 8: repeated-request shielding — built in, on top of the
       -- connected-engagement cap, so one donor is not flooded with matches.
       and (
         select count(*) from public.request_matches rm
         where rm.donor_id = dp.user_id
           and rm.created_at >= now() - interval '30 days'
       ) < ${recoveryCfg.MAX_NEW_MATCHES_PER_DONOR_30D}
     order by p.display_name
     limit ${limit}`;
  // The RPC's Postgres trim() strips SPACES only — a leading newline leaves
  // " select" after whitespace collapsing and trips its ^select guard.
  // Hand it a string whose FIRST character is 's'.
  return sql.trimStart();
}

export const PAGE = MATCHING_CONFIG.PAGE_SIZE;

export async function findCandidates(auth: AuthUser, requestId: string): Promise<Result<Candidate[]>> {
  const gate = await assertCanMatch(auth, requestId);
  if (!gate.ok) return gate;
  const req = gate.data as { blood_group: string; location_id: number };

  const svc = await getService();

  // Phase 10 abuse control: donor-ID enumeration is capped per account per
  // day (server-side counter; the refusal is audited inside the RPC).
  const bump = await svc.rpc("bump_abuse_counter", {
    p_subject: auth.id,
    p_scope: "candidate_list",
  });
  if (bump.error) return err("db_error", bump.error.message);
  const bumpRow = (Array.isArray(bump.data) ? bump.data[0] : bump.data) as
    { allowed: boolean } | null;
  if (!bumpRow?.allowed) {
    return err("rate_limited", "candidate lookup limit reached for today; try again tomorrow");
  }

  // District for tiers 3/4 via the upazila-scope gateway. The RPC declares
  // RETURNS TABLE(district_id, name) — the query must return BOTH columns
  // or Postgres rejects the structure mismatch.
  const { data: dRows, error: dErr } = await svc.rpc("exec_location_sql", {
    q: `select district_id, name from public.upazilas where id = ${req.location_id}`,
  });
  if (dErr) return err("db_error", dErr.message);
  const districtId = (dRows as { district_id: number }[] | null)?.[0]?.district_id;
  if (!districtId) return err("db_error", "unknown upazila id for request location");

  const tiers = [
    { scope: "same_upazila" as const, tier: 1 as CandidateTier, districtId },
    { scope: "neighbour_upazilas" as const, tier: 2 as CandidateTier, districtId },
    { scope: "same_district" as const, tier: 3 as CandidateTier, districtId },
    { scope: "adjacent_districts" as const, tier: 4 as CandidateTier, districtId },
  ];

  const byDonor = new Map<string, Candidate>();
  let sawLocal = 0;

  for (const t of tiers) {
    const sql = candidatesQuery({
      bloodGroup: req.blood_group,
      upazilaId: req.location_id,
      scope: t.scope,
      districtId: t.districtId,
      limit: t.tier === 1 ? MATCHING_CONFIG.MIN_LOCAL_CANDIDATES + 1 : PAGE,
    });
    const { data: rowsRaw, error } = await svc.rpc("exec_matching_sql", { q: sql });
    if (error) return err("db_error", error.message);
    const rows = (rowsRaw ?? []) as unknown as (Candidate & { tier: number })[];

    if (t.tier === 1) sawLocal = rows.length;
    for (const r of rows) {
      // Report each donor at their BEST (lowest) tier; later tiers can't overwrite.
      if (!byDonor.has(r.donor_user_id)) {
        byDonor.set(r.donor_user_id, { ...r, tier: t.tier });
      }
    }
    // Expand only when tier-1 supply is thin, or the pool is still short.
    if (t.tier === 1 && sawLocal >= MATCHING_CONFIG.MIN_LOCAL_CANDIDATES) break;
    if (byDonor.size >= PAGE) break;
  }

  const out = [...byDonor.values()]
    .sort((a, b) => a.tier - b.tier || a.display_name.localeCompare(b.display_name))
    .slice(0, PAGE);

  return { ok: true, data: out };
}

/**
 * Phase 11E — requester-side match creation. Runs the live candidate pool
 * and upserts service-role `pending` matches tagged as the matching engine.
 * Idempotent per (request_id, donor_id): reruns never duplicate rows.
 */
export async function createMatchesFromCandidates(
  auth: AuthUser,
  requestId: string
): Promise<Result<{ created: number; total: number }>> {
  if (!UUID_RE.test(requestId)) return err("validation_error", "invalid request id");

  const pool = await findCandidates(auth, requestId);
  if (!pool.ok) return pool;
  const svc = await getService();

  let created = 0;
  for (const c of pool.data) {
    // expires_at left to the table default (now() + 24h) — no invented TTL.
    const row = {
      request_id: requestId,
      donor_id: c.donor_user_id,
      status: "pending" as const,
      created_by: "matching_engine" as const,
    };
    const { error } = await svc
      .from("request_matches")
      .upsert(row, { onConflict: "request_id,donor_id", ignoreDuplicates: true });
    if (error) return err("db_error", error.message);
    created += 1;
  }
  return { ok: true, data: { created, total: pool.data.length } };
}

/** Requester view of a request's matches: anonymized donor identity only. */
export type RequesterMatchRow = {
  id: string;
  donor_id: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  donor?: { display_name: string } | null;
};

/** Owner/admin list of the matches created for one request (id-guarded). */
export async function listRequestMatches(
  auth: AuthUser,
  requestId: string
): Promise<Result<RequesterMatchRow[]>> {
  if (!UUID_RE.test(requestId)) return err("validation_error", "invalid request id");
  const gate = await assertCanMatch(auth, requestId);
  if (!gate.ok) return gate;
  const client = await getUserClient();
  const { data, error } = await client
    .from("request_matches")
    .select("id, donor_id, status, expires_at, created_at, donor:profiles(display_name)")
    .eq("request_id", requestId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return err("db_error", error.message);
  return { ok: true, data: (data ?? []) as RequesterMatchRow[] };
}

/** Shape the donor sees: request summary embedded, NO contact fields. */
export type DonorMatchRow = {
  id: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  request?: {
    id: string;
    blood_group: string;
    hospital_name: string;
    location_text: string | null;
    urgency: string;
    units_needed: number;
    required_by: string;
    status: string;
  } | null;
};

/** Donor view of their own matches: pass-through of the session client's
 * rows — the service never ADDS contact fields of its own. The session
 * client (cookies via next/headers) keeps RLS scoping to the donor. */
export async function listOwnMatches(auth: AuthUser): Promise<Result<DonorMatchRow[]>> {
  void auth;
  const client = await (async () => {
    const { createAuthedClient } = await import("@/src/lib/db");
    return (await createAuthedClient()) as unknown as SupabaseLike;
  })();
  const { data, error } = await client
    .from("request_matches")
    .select(
      "id, status, expires_at, created_at, " +
        "request:blood_requests(id, blood_group, location_text, urgency, units_needed, required_by, status)"
    )
    .eq("donor_id", auth.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return err("db_error", error.message);
  // blood_requests stores the pickup label in location_text (no hospital_name
  // column); map it so consumers always get a hospital_name display field.
  type RawRow = Record<string, unknown>;
  const rows = ((data ?? []) as unknown as RawRow[]).map((m): DonorMatchRow => {
    const rawReq = (m["request"] ?? null) as RawRow | null;
    const request = rawReq
      ? { ...rawReq, hospital_name: String(rawReq["location_text"] ?? "Unnamed location") } as unknown as DonorMatchRow["request"]
      : null;
    return {
      id: String(m["id"]),
      status: String(m["status"]),
      expires_at: (m["expires_at"] as string | null) ?? null,
      created_at: String(m["created_at"]),
      request,
    };
  });
  return { ok: true, data: rows };
}

export const __internals = { candidatesQuery, PAGE };
void __internals;
