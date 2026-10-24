import "server-only";
import type { AuthUser } from "@/src/lib/auth";
import { RECOVERY_CONFIG } from "@/src/lib/config/recovery";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

type DbError = { message: string };
type SingleRow = { data: unknown };
type ResponseLike = {
  from(table: string): {
    select(cols?: string): {
      eq(col: string, val: string | number): PromiseLike<{ data: unknown; error: DbError | null }>;
    };
  };
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: DbError | null }>;
};

async function getUserClient(): Promise<ResponseLike> {
  // Session-bearing client (cookies via next/headers) — RLS enforces donor
  // ownership of donation rows. An empty-cookie client would degrade to the
  // anon role and hit "permission denied"; never capture cookies here.
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as ResponseLike;
}
async function getService(): Promise<ResponseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as ResponseLike;
}

const rpcRow = (data: unknown) => (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Donor reports a donation (SELF-REPORTED — stored as unverified data, never
 * presented as independently verified). If an approved recovery rule exists
 * for the type, the RPC computes the administrative hold (conflict-safe)
 * and pauses the donor with a donor-facing reason.
 */
export async function reportDonation(
  auth: AuthUser,
  input: { donationDate: string; donationType: string; facility?: string; note?: string }
): Promise<Result<{ state: string; message: string | null; holdUntil: string | null; conflictWith: string | null }>> {
  if (!RECOVERY_CONFIG.DONATION_TYPES.includes(input.donationType as never)) {
    return err("validation_error", "unknown donation type");
  }
  const d = new Date(`${input.donationDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    return err("validation_error", "invalid donation date"); // missing/invalid handled safely
  }
  const isoDate = input.donationDate.slice(0, 10);
  const svc = await getUserClient();
  const { data, error } = await svc.rpc("donor_report_donation", {
    p_donation_date: isoDate,
    p_type: input.donationType,
    p_facility: input.facility ?? null,
    p_note: input.note ?? null,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err(String(row?.state) || "rejected", String(row?.message) || "report rejected");
  return {
    ok: true,
    data: {
      state: String(row.state),
      message: (row.message as string | null) ?? null,
      holdUntil: (row.hold_until as string | null) ?? null,
      conflictWith: (row.conflict_with as string | null) ?? null,
    },
  };
}

/** Donor confirms availability after the hold period ended. */
export async function confirmAvailability(auth: AuthUser): Promise<Result<{ state: string; message: string }>> {
  const svc = await getUserClient();
  const { data, error } = await svc.rpc("donor_confirm_availability", {});
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err(String(row?.state) || "rejected", String(row?.message) || "not allowed yet");
  return { ok: true, data: { state: String(row.state), message: String(row.message) } };
}

/**
 * Recovery state: EXPLAINS the reason and NEVER classifies the donor as
 * medically/clinically eligible. States: recovery_hold | awaiting_confirmation | active.
 */
export type RecoveryState = {
  state: "recovery_hold" | "awaiting_confirmation" | "active";
  holdUntil: string | null;
  reason: string | null;
  paused: boolean;
};

export async function getRecoveryState(auth: AuthUser, donorId?: string): Promise<Result<RecoveryState>> {
  const target = donorId ?? auth.id;
  if (donorId && !isUuid(donorId)) return err("validation_error", "invalid donor id");
  const svc = await getService();
  const { data, error } = await svc.rpc("donor_recovery_state", { p_donor: target });
  if (error) {
    const msg = error.message.toLowerCase();
    return err(msg.includes("not authorized") ? "forbidden" : "db_error", error.message);
  }
  const row = rpcRow(data);
  const state = String(row?.state) as RecoveryState["state"];
  return {
    ok: true,
    data: {
      state,
      holdUntil: (row?.hold_until as string | null) ?? null,
      reason: (row?.reason as string | null) ?? null,
      paused: Boolean(row?.paused),
    },
  };
}

/** Donor's own donation history (verification flags shown honestly). */
export async function listMyDonations(auth: AuthUser): Promise<Result<unknown>> {
  const svc = await getUserClient();
  const { data, error } = await svc
    .from("donation_records")
    .select(
      "id, donation_date, donation_type, facility, report_note, source, verification, verified_basis, conflict_with, created_at"
    )
    .eq("donor_id", auth.id);
  if (error) return err("db_error", error.message);
  return { ok: true, data };
}

/**
 * Admin verification: writes ONLY the separated verification block. The
 * donor-reported fields are untouched, and accepted values cannot upgrade a
 * self-report into an implied verified fact anywhere else in the codebase.
 */
export async function adminVerifyDonation(
  auth: AuthUser,
  recordId: string,
  status: "verified" | "rejected" | "unverified",
  basis: string,
  actorRole: "admin" | "partner" = "admin"
): Promise<Result<{ status: string }>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const svc = await getService();
  const { data, error } = await svc.rpc("admin_verify_donation", {
    p_record: recordId,
    p_status: status,
    p_basis: basis,
    p_actor_role: actorRole,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) || "verification refused");
  return { ok: true, data: { status: String(row.message) } };
}

/** Admin records an approved recovery rule (named approver + reference required). */
export async function adminSetRecoveryRule(
  auth: AuthUser,
  input: { donationType: string; days: number; approvedByName: string; approvalReference: string }
): Promise<Result<{ message: string }>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const svc = await getService();
  const { data, error } = await svc.rpc("admin_set_recovery_rule", {
    p_type: input.donationType,
    p_days: input.days,
    p_approved_by_name: input.approvedByName,
    p_approval_reference: input.approvalReference,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err("rejected", String(row?.message) || "rule rejected");
  return { ok: true, data: { message: String(row.message) } };
}

/**
 * Admin override of a hold. Permission-controlled (admin) AND
 * authorization-controlled (a named medical authority is required — an
 * attempt without one is refused AND audited as hold.override_refused).
 */
export async function adminLiftHold(
  auth: AuthUser,
  donorId: string,
  note: string,
  medicalAuthorityName: string
): Promise<Result<{ message: string }>> {
  if (!auth.isAdmin) return err("forbidden", "admin only");
  const svc = await getService();
  const { data, error } = await svc.rpc("admin_lift_hold", {
    p_donor: donorId,
    p_note: note ?? "",
    p_medical_authority_name: medicalAuthorityName,
  });
  if (error) return err("db_error", error.message);
  const row = rpcRow(data);
  if (!row?.ok) return err(String(row?.message)?.includes("medical authority") ? "requirement_missing" : "rejected", String(row?.message) || "override refused");
  return { ok: true, data: { message: String(row.message) } };
}
