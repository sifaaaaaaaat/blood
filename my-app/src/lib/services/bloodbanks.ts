import "server-only";
import type { AuthUser } from "@/src/lib/auth";
import { getServiceRoleClient } from "@/src/lib/db";
import type {
  BankFilter,
  CreateBloodBankInput,
  ProposeBloodBankInput,
  UpdateBloodBankInput,
} from "@/src/lib/validation/directory";

/**
 * Blood-bank directory service (Phase 11C).
 *
 * AUTHORISATION MODEL (identical to Phase 10):
 *  · Public reads run through the service-role client but ONLY ever return
 *    published rows — the same visibility the anon-role RLS policy grants
 *    over PostgREST; an unpublished row can never reach this path.
 *  · Admin mutations go through the requester's OWN session client into
 *    admin_* RPCs that re-verify is_admin inside Postgres from auth.uid().
 *    A forged app-level flag can never perform a write.
 *  · No stock/inventory data exists in this phase — the mission decision was
 *    directory-only for 11C; inventory lands with 11F.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

export type CookieProvider = () => Promise<{ name: string; value: string }[]>;
type DbError = { message: string } | null;

type Filterable = {
  eq(col: string, v: string | number | boolean): Filterable;
  ilike(col: string, v: string): Filterable;
  contains(col: string, v: unknown[]): Filterable;
  or(expr: string): Filterable;
  order(col: string, opts?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
  limit(n: number): PromiseLike<QueryResult>;
};
type QueryResult = { data: unknown; error: DbError };
type SupabaseLike = {
  from(table: string): { select(cols: string, opts?: unknown): Filterable };
  rpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult>;
};
type RpcResult = { data: unknown; error: DbError };

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}
async function getSessionClient(getCookies: CookieProvider): Promise<SupabaseLike> {
  const { createUserClient } = await import("@/src/lib/db");
  return (await createUserClient(getCookies)) as unknown as SupabaseLike;
}

const rpcRow = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Public directory read
// ---------------------------------------------------------------------------

export type BloodBankCard = {
  id: string;
  slug: string;
  name: string;
  nameBn: string | null;
  kind: string;
  divisionName: string;
  divisionNameBn: string;
  districtName: string;
  districtNameBn: string;
  upazilaName: string | null;
  upazilaNameBn: string | null;
  address: string;
  sourceNote: string;
  groupsAtIssue: string[];
  phonePublic: string | null;
  openingHours: string | null;
  publishedAt: string | null;
  /** Phase 11F: reported stock — REAL updates from the bank's own accounts. */
  stock?: { group: string; units: number; reportedAt: string }[];
};

export type LocationOption = { id: number; name: string; nameBn: string };

export const BANK_SELECT =
  "id, slug, name, name_bn, kind, address, source_note, groups_at_issue, phone_public, opening_hours, published_at, "
  + "district_name:districts(id, name, bn_name, divisions(id, name, bn_name)), "
  + "upazila_name:upazilas(id, name, bn_name)";

function mapRow(row: Record<string, unknown>): BloodBankCard | null {
  const district = row["district_name"] as Record<string, unknown> | null;
  if (!district) return null;
  const division = (district["divisions"] ?? null) as Record<string, unknown> | null;
  const upazila = (row["upazila_name"] ?? null) as Record<string, unknown> | null;
  return {
    id: String(row["id"]),
    slug: String(row["slug"]),
    name: String(row["name"]),
    nameBn: (row["name_bn"] as string) ?? null,
    kind: String(row["kind"]),
    divisionName: String(division?.["name"] ?? ""),
    divisionNameBn: String(division?.["bn_name"] ?? ""),
    districtName: String(district["name"]),
    districtNameBn: String(district["bn_name"]),
    upazilaName: upazila ? String(upazila["name"]) : null,
    upazilaNameBn: upazila ? String(upazila["bn_name"]) : null,
    address: String(row["address"]),
    sourceNote: String(row["source_note"] ?? ""),
    groupsAtIssue: Array.isArray(row["groups_at_issue"]) ? (row["groups_at_issue"] as string[]) : [],
    phonePublic: (row["phone_public"] as string) ?? null,
    openingHours: (row["opening_hours"] as string) ?? null,
    publishedAt: (row["published_at"] as string) ?? null,
  };
}

/** Escape the %, , and ( ) / " characters that PostgREST would treat as filter syntax. */
function sanitizeSearch(q: string): string {
  return q.replace(/[%()",\\]/g, " ").trim();
}

export async function listPublishedBanks(filter: BankFilter): Promise<Result<BloodBankCard[]>> {
  const svc = await getService();
  let query = svc.from("blood_banks").select(BANK_SELECT);
  // Ranked before the embed: matches truthy only when is_published, so even a
  // service-role read is constrained to the public directory surface.
  query = query.eq("is_published", true);
  if (filter.divisionId !== undefined) query = query.eq("division_id", filter.divisionId);
  if (filter.districtId !== undefined) query = query.eq("district_id", filter.districtId);
  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.group) query = query.contains("groups_at_issue", [filter.group]);
  const q = filter.q ? sanitizeSearch(filter.q) : "";
  if (q) query = query.or(`name.ilike.%${q}%,name_bn.ilike.%${q}%`);
  const { data, error } = await query
    .order("name", { ascending: true })
    .limit(filter.limit + filter.offset);
  if (error) return err("db_error", error.message);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const mapped = rows.slice(filter.offset).map(mapRow).filter((m): m is BloodBankCard => m !== null);

  // Phase 11F: attach the latest reported stock per bank — REAL updates from
  // bank members only (never synthesized, never guessed). One aggregate query
  // for the page; banks without reports simply carry no stock array.
  const ids = Array.from(new Set(mapped.map((b) => b.id))).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length > 0) {
    const { data: sRows, error: sErr } = await svc.rpc("exec_matching_sql", {
      q: `select distinct on (bank_id, blood_group) bank_id, blood_group::text as blood_group,
            units::int as units, created_at
           from public.bank_stock
          where bank_id::text in (${ids.map((i) => `'${i}'`).join(",")})
          order by bank_id, blood_group, created_at desc`,
    });
    if (!sErr && Array.isArray(sRows)) {
      const byBank = new Map<string, NonNullable<BloodBankCard["stock"]>>();
      for (const r of sRows as { bank_id: string; blood_group: string; units: number; created_at: string }[]) {
        const key = String(r.bank_id);
        const list = byBank.get(key) ?? [];
        list.push({ group: r.blood_group, units: Number(r.units), reportedAt: String(r.created_at) });
        byBank.set(key, list);
      }
      for (const b of mapped) {
        const stock = byBank.get(b.id);
        if (stock && stock.length > 0) b.stock = stock.sort((a, z) => a.group.localeCompare(z.group));
      }
    }
  }

  return { ok: true, data: mapped };
}

/**
 * Exact count of published blood banks (head query, no rows). Used by the
 * homepage campaign card; null when the database is unreachable so the card
 * renders the honest pending dash instead of a zero-that-looks-real.
 */
export async function getPublishedBankCount(): Promise<number | null> {
  try {
    const supabase = getServiceRoleClient();
    const res = await supabase
      .from("blood_banks")
      .select("id", { count: "exact", head: true })
      .eq("is_published", true);
    const e = res.error as { message: string } | null;
    const count = (res as { count?: unknown }).count;
    if (e !== null || typeof count !== "number") return null;
    return count;
  } catch {
    return null;
  }
}

export async function listDivisionOptions(): Promise<Result<LocationOption[]>> {
  const svc = await getService();
  const { data, error } = await svc.from("divisions").select("id, name, bn_name")
    .order("id", { ascending: true }).limit(20);
  if (error) return err("db_error", error.message);
  return { ok: true, data: decodeOptions(data) };
}

export async function listDistrictOptions(divisionId: number): Promise<Result<LocationOption[]>> {
  if (!Number.isInteger(divisionId) || divisionId <= 0) return err("validation_error", "division required");
  const svc = await getService();
  const { data, error } = await svc.from("districts").select("id, name, bn_name")
    .eq("division_id", divisionId)
    .order("name", { ascending: true }).limit(80);
  if (error) return err("db_error", error.message);
  return { ok: true, data: decodeOptions(data) };
}

function decodeOptions(data: unknown): LocationOption[] {
  return (Array.isArray(data) ? data : []).map((r) => {
    const row = r as Record<string, unknown>;
    return { id: Number(row["id"]), name: String(row["name"]), nameBn: String(row["bn_name"]) };
  });
}

// ---------------------------------------------------------------------------
// Admin path: list-all, create, update, publish — session-gated, DB-reverified
// ---------------------------------------------------------------------------

function refusedForNonAdmin(auth: AuthUser): Result<never> | null {
  return auth.isAdmin ? null : err("forbidden", "admin only");
}

export async function adminListAllBanks(
  getCookies: CookieProvider,
  auth: AuthUser
): Promise<Result<unknown>> {
  const refused = refusedForNonAdmin(auth);
  if (refused) return refused;
  const svc = await getService();
  const { data, error } = await svc.from("blood_banks").select(
    "id, slug, name, name_bn, kind, district_name:districts(id, name, bn_name), address, phone_public, source_note, is_published, published_at, created_at"
  ).order("created_at", { ascending: false }).limit(200);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

export async function adminCreateBloodBank(
  getCookies: CookieProvider,
  auth: AuthUser,
  input: CreateBloodBankInput
): Promise<Result<{ id: string }>> {
  const refused = refusedForNonAdmin(auth);
  if (refused) return refused;
  const client = await getSessionClient(getCookies);
  const { data, error } = await client.rpc("admin_create_blood_bank", {
    p_slug: input.slug,
    p_name: input.name,
    p_name_bn: input.nameBn ?? null,
    p_kind: input.kind,
    p_division: input.divisionId,
    p_district: input.districtId,
    p_upazila: input.upazilaId ?? null,
    p_address: input.address,
    p_groups: input.groups ?? [],
    p_phone: input.phone ?? null,
    p_hours: input.openingHours ?? null,
    p_source_note: input.sourceNote,
    p_publish: input.publish,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) ?? "refused");
  return { ok: true, data: { id: String(row["bank_id"]) } };
}

/**
 * Signed-in users may PROPOSE a bank for the directory. Stored unpublished
 * (pending review) through user_propose_blood_bank, which re-verifies the
 * session inside Postgres and never trusts a client id/slug/publish flag.
 * The submitter's account is recorded as created_by; admins publish later.
 */
export async function proposeBloodBank(
  getCookies: CookieProvider,
  auth: AuthUser,
  input: ProposeBloodBankInput
): Promise<Result<{ id: string }>> {
  if (!auth) return err("unauthorized", "sign-in required");
  const client = await getSessionClient(getCookies);
  const { data, error } = await client.rpc("user_propose_blood_bank", {
    p_name: input.name,
    p_name_bn: input.nameBn ?? null,
    p_kind: input.kind,
    p_division: input.divisionId,
    p_district: input.districtId,
    p_upazila: input.upazilaId ?? null,
    p_address: input.address,
    p_phone: input.phone ?? null,
    p_hours: input.openingHours ?? null,
    p_source_note: input.sourceNote,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) ?? "refused");
  return { ok: true, data: { id: String(row["bank_id"]) } };
}

export async function adminUpdateBloodBank(
  getCookies: CookieProvider,
  auth: AuthUser,
  bankId: string,
  input: UpdateBloodBankInput
): Promise<Result<unknown>> {
  const refused = refusedForNonAdmin(auth);
  if (refused) return refused;
  const client = await getSessionClient(getCookies);
  const { data, error } = await client.rpc("admin_update_blood_bank", {
    p_id: bankId,
    p_name: input.name ?? null,
    p_name_bn: input.nameBn ?? null,
    p_kind: input.kind ?? null,
    p_division: input.divisionId ?? null,
    p_district: input.districtId ?? null,
    p_upazila: input.upazilaId ?? null,
    p_address: input.address ?? null,
    p_groups: input.groups ?? null,
    p_phone: input.phone ?? null,
    p_hours: input.openingHours ?? null,
    p_source_note: input.sourceNote ?? null,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) ?? "refused");
  return { ok: true, data: {} };
}

export async function adminPublishBloodBank(
  getCookies: CookieProvider,
  auth: AuthUser,
  bankId: string,
  publish: boolean
): Promise<Result<unknown>> {
  const refused = refusedForNonAdmin(auth);
  if (refused) return refused;
  const client = await getSessionClient(getCookies);
  const { data, error } = await client.rpc("admin_publish_blood_bank", {
    p_id: bankId,
    p_publish: publish,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) ?? "refused");
  return { ok: true, data: {} };
}
