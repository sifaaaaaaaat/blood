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
      eq(c: string, v: unknown): { maybeSingle(): PromiseLike<RpcResult> };
    };
  };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
};

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

async function getUserClient(): Promise<SupabaseLike> {
  const { createUserClient } = await import("@/src/lib/db");
  return (await createUserClient(async () => [])) as unknown as SupabaseLike;
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

  return `
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
       -- Phase 8: donors under an (unlifted) administrative recovery hold are
       -- excluded from ordinary matching. Holds persist until the DONOR
       -- confirms availability after the configured period (expiry does not
       -- auto-restore matching), so checking lifted=false is correct.
       and not exists (
         select 1 from public.donor_recovery_holds hh
          where hh.donor_id = dp.user_id and hh.lifted = false
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
}

export const PAGE = MATCHING_CONFIG.PAGE_SIZE;

export async function findCandidates(auth: AuthUser, requestId: string): Promise<Result<Candidate[]>> {
  const gate = await assertCanMatch(auth, requestId);
  if (!gate.ok) return gate;
  const req = gate.data as { blood_group: string; location_id: number };

  const svc = await getService();

  // District for tiers 3/4 via the upazila-scope gateway.
  const { data: dRows, error: dErr } = await svc.rpc("exec_location_sql", {
    q: `select district_id from public.upazilas where id = ${req.location_id}`,
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

export const __internals = { candidatesQuery, PAGE };
void __internals;
