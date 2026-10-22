import "server-only";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export type LocationOption = { id: number; name: string; nameBn: string };

type DbError = { message: string } | null;
type QueryResult = { data: unknown; error: DbError };
type Filterable = {
  eq(col: string, v: string | number | boolean): Filterable;
  order(col: string, opts?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
  limit(n: number): PromiseLike<QueryResult>;
};
type SupabaseLike = {
  from(table: string): { select(cols: string, opts?: unknown): Filterable };
};

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

function decode(data: unknown): LocationOption[] {
  return (Array.isArray(data) ? data : []).map((r) => {
    const row = r as Record<string, unknown>;
    return { id: Number(row["id"]), name: String(row["name"]), nameBn: String(row["bn_name"]) };
  });
}

const fail = (error: { message: string }): Result<never> => ({ ok: false, code: "db_error", message: error.message });

export async function listDivisions(): Promise<Result<LocationOption[]>> {
  const svc = await getService();
  const { data, error } = await svc.from("divisions").select("id, name, bn_name")
    .order("id", { ascending: true }).limit(20);
  if (error) return fail(error);
  return { ok: true, data: decode(data) };
}

export async function listDistricts(divisionId: number): Promise<Result<LocationOption[]>> {
  if (!Number.isInteger(divisionId) || divisionId <= 0) {
    return { ok: false, code: "validation_error", message: "divisionId required" };
  }
  const svc = await getService();
  const { data, error } = await svc.from("districts").select("id, name, bn_name")
    .eq("division_id", divisionId)
    .order("name", { ascending: true }).limit(80);
  if (error) return fail(error);
  return { ok: true, data: decode(data) };
}

export async function listUpazilas(districtId: number): Promise<Result<LocationOption[]>> {
  if (!Number.isInteger(districtId) || districtId <= 0) {
    return { ok: false, code: "validation_error", message: "districtId required" };
  }
  const svc = await getService();
  const { data, error } = await svc.from("upazilas").select("id, name, bn_name")
    .eq("district_id", districtId)
    .order("name", { ascending: true }).limit(200);
  if (error) return fail(error);
  return { ok: true, data: decode(data) };
}
