import "server-only";
import { z } from "zod";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type DbError = { message: string } | null;
type RpcResult = { data: unknown; error: DbError };
type Row = Record<string, unknown>;
type QueryResult = { data: unknown; error: DbError };

type TableLike = {
  select(cols: string, opts?: unknown): {
    eq(c: string, v: string | boolean): {
      order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
      limit(n: number): PromiseLike<QueryResult>;
    };
    order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<QueryResult> };
  };
  rpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult>;
};
type ClientLike = { from(t: string): TableLike };

async function getService(): Promise<ClientLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as ClientLike;
}
async function getAuthed(): Promise<ClientLike> {
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as ClientLike;
}

/**
 * Phase 11G — camps service. Admin writes run through an admin RPC that
 * re-verifies is_admin inside Postgres; the public surface selects published
 * camps only. Nothing is ever synthesized: empty list = no real camps yet.
 */

const CAMP_SELECT =
  "id, name, name_bn, org_name, location_text, divisions(name, bn_name), districts(name, bn_name), starts_at, ends_at, source_note, published_at";

export type CampCard = {
  id: string;
  name: string;
  nameBn: string | null;
  orgName: string;
  locationText: string;
  divisionName: string | null;
  districtName: string | null;
  startsAt: string;
  endsAt: string;
  sourceNote: string;
};

function mapCamp(row: Row): CampCard {
  const div = row["divisions"] as Row | null;
  const dist = row["districts"] as Row | null;
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    nameBn: (row["name_bn"] as string) ?? null,
    orgName: String(row["org_name"]),
    locationText: String(row["location_text"] ?? ""),
    divisionName: div ? String(div["name"]) : null,
    districtName: dist ? String(dist["name"]) : null,
    startsAt: String(row["starts_at"]),
    endsAt: String(row["ends_at"]),
    sourceNote: String(row["source_note"] ?? ""),
  };
}

/** Upcoming published camps (public surface; service role but filtered). */
export async function listUpcomingCamps(limit = 50): Promise<Result<CampCard[]>> {
  const svc = await getService();
  const { data, error } = await svc
    .from("camps")
    .select(CAMP_SELECT)
    .eq("is_published", true)
    .order("starts_at", { ascending: true } as never)
    .limit(limit);
  if (error) return err("db_error", error!.message);
  const rows = ((Array.isArray(data) ? data : []) as unknown as Row[]).map(mapCamp);
  return { ok: true, data: rows };
}

const campUpsertSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(160),
    name_bn: z.string().trim().max(160).optional(),
    org_name: z.string().trim().min(2).max(160),
    division_id: z.number().int().min(1).optional(),
    district_id: z.number().int().min(1).optional(),
    location_text: z.string().trim().max(240).default(""),
    starts_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid starts_at"),
    ends_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ends_at"),
    source_note: z.string().trim().min(2).max(300),
    is_published: z.boolean().default(false),
  })
  .strict()
  .refine((v) => Date.parse(v.ends_at) >= Date.parse(v.starts_at), { message: "ends_at before starts_at", path: ["ends_at"] });
export type CampUpsertInput = z.infer<typeof campUpsertSchema>;

const stamp = (s?: string): string | null =>
  s ? new Date(s).toISOString() : null;

/** Admin create/update via the DB-reverified RPC (app-level check first). */
export async function adminUpsertCamp(auth: AuthUser, input: unknown): Promise<Result<CampCard>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const parsed = campUpsertSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message);
  }
  const v = parsed.data;
  const client = await getAuthed();
  const { data, error } = await client.from("camps").rpc("admin_camp_upsert", {
    p_id: v.id ?? null,
    p_name: v.name,
    p_name_bn: v.name_bn ?? null,
    p_org_name: v.org_name,
    p_division: v.division_id ?? null,
    p_district: v.district_id ?? null,
    p_location: v.location_text,
    p_starts_at: stamp(v.starts_at),
    p_ends_at: stamp(v.ends_at),
    p_source_note: v.source_note,
    p_is_published: v.is_published,
  });
  if (error?.message?.toLowerCase().startsWith("admin only")) return err("forbidden", error!.message!);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: mapCamp((data ?? {}) as Row) };
}

/** Admin listing of all camps (draft + published). */
export async function adminListCamps(auth: AuthUser): Promise<Result<Row[]>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const svc = await getService();
  const { data, error } = await svc
    .from("camps")
    .select("*")
    .order("created_at", { ascending: false } as never)
    .limit(200);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: (data ?? []) as unknown as Row[] };
}
