import "server-only";
import { z } from "zod";
import { bloodGroupSchema } from "@/src/lib/validation/donor";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type DbError = { message: string } | null;
type RpcResult = { data: unknown; error: DbError };

interface MbChain {
  eq(c: string, v: unknown): MbChain;
  order?(c: string, o?: { ascending?: boolean }): { limit?(n: number): PromiseLike<RpcResult> };
  maybeSingle(): PromiseLike<RpcResult>;
}
interface OrderChain {
  eq2?: never;
  order(c: string, o?: { ascending?: boolean }): { limit(n: number): PromiseLike<RpcResult> };
}
interface ServiceTable {
  select(cols: string): MbChain & Partial<OrderChain>;
  upsert(v: unknown, o?: Record<string, unknown>): PromiseLike<WithErr>;
  insert(v: unknown): PromiseLike<WithErr>;
  update(v: unknown): { eq(c: string, v: unknown): PromiseLike<WithErr> };
}
type WithErr = { error: DbError };

interface AuthedClient {
  from(t: string): ServiceTable;
}
interface ServiceClient {
  from(t: string): ServiceTable;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

async function getAuthed(): Promise<AuthedClient> {
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as AuthedClient;
}
async function getService(): Promise<ServiceClient> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as ServiceClient;
}

/**
 * Phase 11F — blood-bank organization services.
 *
 * Membership is provisioned by platform admins; bank members report stock
 * updates for THEIR OWN bank, timestamped and attributed. The directory shows
 * stock only from these reports — the "no invented data" rule stays intact.
 */

const bankUpdateSchema = z.object({
  blood_group: bloodGroupSchema,
  units: z.number().int().min(0).max(10000),
});

export const stockReportSchema = z.object({
  updates: z.array(bankUpdateSchema).min(1).max(8),
  source_note: z.string().trim().max(200).optional(),
});

export type BankSummary = {
  bankId: string;
  name: string;
  nameBn: string | null;
  kind: string;
  address: string;
  role: string;
};

/** Banks the signed-in account belongs to (RLS bank_orgs_member_select). */
export async function listMyBanks(userId: string): Promise<Result<BankSummary[]>> {
  const client = await getAuthed();
  const { data, error } = await client.from("bank_orgs").select(
    "role, banks(id, name, name_bn, kind, address)"
  ).eq("user_id", userId) as unknown as {
    data: { role: string; banks: Record<string, unknown> | null }[] | null;
    error: DbError;
  };
  if (error) return err("db_error", error!.message);
  const rows = ((data ?? []) as { role: string; banks: Record<string, unknown> | null }[]).filter((r) => r.banks);
  return {
    ok: true,
    data: rows.map((r) => ({
      bankId: String(r.banks!["id"]),
      name: String(r.banks!["name"]),
      nameBn: (r.banks!["name_bn"] as string) ?? null,
      kind: String(r.banks!["kind"]),
      address: String(r.banks!["address"] ?? ""),
      role: r.role,
    })),
  };
}

/** Membership proof: the caller's own bank_orgs row for this bank (RLS-scoped). */
async function memberRowOrAdmin(
  auth: AuthUser,
  bankId: string
): Promise<{ ok: boolean; message?: string; code?: string }> {
  const client = await getAuthed();
  const { data, error } = await client.from("bank_orgs").select("id").eq("bank_id", bankId).eq("user_id", auth.id).maybeSingle();
  if (error) return { ok: false, code: "db_error", message: error!.message };
  if (!data && !auth.isAdmin) {
    return { ok: false, code: "forbidden", message: "you are not a member of this blood bank" };
  }
  return { ok: true };
}

export type StockRow = { blood_group: string; units: number; created_at: string; source_note: string | null };

/** The member's own bank's stock history (RLS bank_stock_member_select). */
export async function listBankStock(auth: AuthUser, bankId: string): Promise<Result<StockRow[]>> {
  const member = await memberRowOrAdmin(auth, bankId);
  if (!member.ok) return err(member.code!, member.message!);

  const client = await getAuthed();
  const { data, error } = await client
    .from("bank_stock")
    .select("blood_group, units, created_at, source_note")
    .eq("bank_id", bankId)
    .order!("created_at", { ascending: false })
    .limit!(200);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: ((data ?? []) as unknown as StockRow[]) };
}

/** Report new stock for the member's bank. Server validates shape + membership. */
export async function reportStock(
  auth: AuthUser,
  bankId: string,
  input: unknown
): Promise<Result<{ inserted: number }>> {
  const parsed = stockReportSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message);
  }
  const member = await memberRowOrAdmin(auth, bankId);
  if (!member.ok) return err(member.code!, member.message!);

  const svc = await getService();
  const { data, error } = await svc.rpc("report_bank_stock", {
    p_bank_id: bankId,
    p_updates: JSON.stringify(parsed.data.updates),
    p_source_note: parsed.data.source_note ?? null,
  });
  if (error) {
    const msg = (error?.message ?? "").toLowerCase();
    if (msg.includes("not a member")) return err("forbidden", error!.message);
    return err("db_error", error!.message);
  }
  return { ok: true, data: { inserted: Number(data) || 0 } };
}

/** Admin provisioning: attach an account to a bank (auth pre-check + service write). */
export async function adminProvisionOrg(
  auth: AuthUser,
  bankId: string,
  input: unknown
): Promise<Result<{ linked: true }>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const parsed = z
    .object({ user_id: z.string().uuid(), role: z.enum(["admin", "inventory"]).default("inventory") })
    .safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message);
  }
  const svc = await getService();
  const { error } = await svc
    .from("bank_orgs")
    .upsert({ bank_id: bankId, user_id: parsed.data.user_id, role: parsed.data.role }, { onConflict: "bank_id,user_id" });
  if (error) return err("db_error", error!.message);
  return { ok: true, data: { linked: true } };
}
