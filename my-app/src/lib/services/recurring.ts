import "server-only";
import { z } from "zod";
import { bloodGroupSchema } from "@/src/lib/validation/donor";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; field?: string; message: string };
const err = (code: string, message: string, field?: string): Result<never> => ({ ok: false, code, field, message });

/**
 * Phase 11J — recurring (thalassemia) schedules.
 *
 * A schedule NEVER sends anything. Materializing creates a DRAFT blood
 * request owned by the schedule's creator, which then follows the standard
 * submit → match → accept → contact flow with all its consent gates.
 * Owner RLS-scoped everywhere; consent required at creation and re-checked
 * before every materialization.
 */

type DbError = { message: string } | null;
type QueryResult = { data: unknown; error: DbError };
type Row = Record<string, unknown>;

type PostgrestLike = {
  from: (table: string) => PostgrestLike;
  select: (cols?: string) => PostgrestLike;
  insert: (values: unknown) => PostgrestLike;
  update: (values: unknown) => PostgrestLike;
  delete: () => PostgrestLike;
  eq: (col: string, val: unknown) => PostgrestLike;
  order: (col: string, opts?: { ascending?: boolean }) => PostgrestLike;
  limit: (n: number) => PostgrestLike;
  maybeSingle: () => PromiseLike<QueryResult>;
  single: () => PromiseLike<QueryResult>;
  then: (
    onFulfilled?: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => PromiseLike<QueryResult>;
};

/**
 * The client itself must NOT be thenable — otherwise `await client` would
 * unwrap to a QueryResult — so the `then` lives on the chain values only.
 */
type ClientLike = {
  from(table: string): PostgrestLike;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<QueryResult>;
};

async function getAuthedClient(): Promise<ClientLike> {
  const { createAuthedClient } = await import("@/src/lib/db");
  return (await createAuthedClient()) as unknown as ClientLike;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export type Schedule = {
  id: string;
  patient_label: string;
  blood_group: string;
  hospital_name: string;
  location_id: number;
  location_text: string | null;
  units_needed: number;
  interval_days: number;
  contact_pref: string;
  consent_confirmed: boolean;
  active: boolean;
  next_due_at: string;
  last_request_id: string | null;
  last_materialized_at: string | null;
};

export const scheduleCreateSchema = z
  .object({
    patient_label: z.string().trim().max(80).default(""),
    blood_group: bloodGroupSchema,
    hospital_name: z.string().trim().min(2).max(120),
    location: z.object({ upazila_id: z.number().int().min(1).max(99999) }),
    location_text: z.string().trim().max(240).optional(),
    units_needed: z.number().int().min(1).max(20),
    interval_days: z.number().int().min(1).max(365),
    contact_pref: z.enum(["in_app", "sms", "phone_call"]).default("in_app"),
    consent_confirmed: z.literal(true),
  })
  .strict();
export type ScheduleCreateInput = z.infer<typeof scheduleCreateSchema>;

const rowToSchedule = (row: Row): Schedule => ({
  id: String(row["id"]),
  patient_label: String(row["patient_label"] ?? ""),
  blood_group: String(row["blood_group"]),
  hospital_name: String(row["hospital_name"]),
  location_id: Number(row["location_id"]),
  location_text: (row["location_text"] as string) || null,
  units_needed: Number(row["units_needed"]),
  interval_days: Number(row["interval_days"]),
  contact_pref: String(row["contact_pref"]),
  consent_confirmed: row["consent_confirmed"] === true,
  active: row["active"] === true,
  next_due_at: String(row["next_due_at"]),
  last_request_id: (row["last_request_id"] as string) || null,
  last_materialized_at: (row["last_materialized_at"] as string) || null,
});

/**
 * The owner's schedules, due-soonest first (RLS recurring_owner_rw).
 * Paused schedules stay in the list (they can be resumed). Privacy-honest
 * deletes scrub consent and deactivate — those rows simply disappear here.
 */
export async function listSchedules(auth: AuthUser): Promise<Result<Schedule[]>> {
  const client = await getAuthedClient();
  const { data, error } = await client
    .from("recurring_requests")
    .select("*")
    .eq("creator_id", auth.id)
    .order("next_due_at", { ascending: true })
    .limit(50);
  if (error) return err("db_error", error!.message);
  const rows = ((data ?? []) as unknown as Row[]).map(rowToSchedule);
  return {
    ok: true,
    data: rows.filter((s) => s.active || s.consent_confirmed),
  };
}

export async function createSchedule(auth: AuthUser, input: unknown): Promise<Result<Schedule>> {
  const parsed = scheduleCreateSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message, i.path.join("."));
  }
  const v = parsed.data;
  const client = await getAuthedClient();
  // RLS recurring_owner_insert requires creator_id = auth.uid() AND
  // consent_confirmed = true on the row itself.
  const { data, error } = await client
    .from("recurring_requests")
    .insert({
      creator_id: auth.id,
      patient_label: v.patient_label,
      blood_group: v.blood_group,
      hospital_name: v.hospital_name,
      location_id: v.location.upazila_id,
      location_text: v.location_text || v.hospital_name,
      units_needed: v.units_needed,
      interval_days: v.interval_days,
      contact_pref: v.contact_pref,
      consent_confirmed: true,
      active: true,
      // Reviewable immediately on creation: the owner can generate the draft
      // right away and then submit it through the standard flow.
      next_due_at: new Date().toISOString(),
    })
    .select("*");
  if (error) return err("db_error", error!.message);
  const rows = (data ?? []) as unknown as Row[];
  if (!rows[0]) return err("db_error", "insert returned no row (RLS rejected?)");
  const s = rowToSchedule(rows[0]);
  // RLS may legitimately reject a row whose creator/consent doesn't match.
  if (s.consent_confirmed !== true || !s.active) return err("forbidden", "consent required");
  return { ok: true, data: s };
}

/** Pause or resume ONE schedule (per-schedule scoping; never a whole set). */
export async function setScheduleActive(
  auth: AuthUser,
  scheduleId: string,
  active: boolean
): Promise<Result<{ updated: true }>> {
  if (!UUID_RE.test(scheduleId)) return err("validation_error", "invalid schedule id");
  const client = await getAuthedClient();

  // Ownership proven through the RLS select first (serialized audit trail
  // keeps delete-honesty: resuming scrubs nothing the owner didn't set).
  const { data } = await client
    .from("recurring_requests")
    .select("id")
    .eq("id", scheduleId)
    .eq("creator_id", auth.id)
    .maybeSingle();
  if (!data) return err("not_found", "schedule not found (or not yours)");

  const { error } = await client
    .from("recurring_requests")
    .update({
      active,
      // Resuming restarts the cycle from now; pausing leaves it alone.
      ...(active ? { next_due_at: new Date().toISOString() } : {}),
    })
    .eq("id", scheduleId)
    .eq("creator_id", auth.id);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: { updated: true } };
}

/**
 * Privacy-honest delete: mark the schedule inactive AND scrub its
 * identifying fields (patient_label, consent). Its generated draft requests
 * belong to the owner's request history and are their data to manage.
 */
export async function deleteSchedule(auth: AuthUser, scheduleId: string): Promise<Result<{ deleted: true }>> {
  if (!UUID_RE.test(scheduleId)) return err("validation_error", "invalid schedule id");
  const client = await getAuthedClient();

  const { data } = await client
    .from("recurring_requests")
    .select("id")
    .eq("id", scheduleId)
    .eq("creator_id", auth.id)
    .maybeSingle();
  if (!data) return err("not_found", "schedule not found (or not yours)");

  const { error } = await client
    .from("recurring_requests")
    .update({ active: false, patient_label: "", consent_confirmed: false })
    .eq("id", scheduleId)
    .eq("creator_id", auth.id);
  if (error) return err("db_error", error!.message);
  return { ok: true, data: { deleted: true } };
}

/**
 * Materialize a DUE schedule as the creator's DRAFT blood request. The draft
 * goes through createRequest (validation caps, consent literal, transition
 * history); the owner reviews and submits it from their requests page.
 * Deterministic advance: next_due moves forward by exactly one interval from
 * the value it had at materialization time.
 */
export async function materializeDraft(
  auth: AuthUser,
  scheduleId: string
): Promise<Result<{ requestId: string | null; due: boolean; nextDueAt: string | null }>> {
  if (!UUID_RE.test(scheduleId)) return err("validation_error", "invalid schedule id");
  const client = await getAuthedClient();

  const { data, error } = await client
    .from("recurring_requests")
    .select("*")
    .eq("id", scheduleId)
    .eq("creator_id", auth.id)
    .maybeSingle();
  if (error) return err("db_error", error!.message);
  if (!data) return err("not_found", "schedule not found (or not yours)");
  const s = rowToSchedule(data as unknown as Row);
  if (!s.active) return err("invalid_state", "schedule is paused");
  if (!s.consent_confirmed) return err("forbidden", "consent not confirmed for this schedule");

  const dueAt = Date.parse(s.next_due_at);
  if (dueAt > Date.now()) {
    return { ok: true, data: { requestId: null, due: false, nextDueAt: s.next_due_at } };
  }

  const requests = await import("@/src/lib/services/requests");
  const created = await requests.createRequest(
    auth,
    {
      blood_group: s.blood_group,
      hospital_name: s.hospital_name,
      location: { upazila_id: s.location_id },
      location_text: s.location_text ?? undefined,
      urgency: "routine",
      units_needed: s.units_needed,
      required_by: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      request_notes: s.patient_label ? `Recurring schedule — ${s.patient_label}` : "Recurring schedule",
      consent_confirmed: true,
      contact_pref: s.contact_pref as "in_app" | "sms" | "phone_call",
      idempotency_key: crypto.randomUUID(),
    },
    { asDraft: true }
  );
  if (!created.ok) {
    // Materialization may legitimately fail on caps/limits — surface it.
    return err(created.code, created.message);
  }
  const requestId = (created.data as { id?: string }).id ?? null;

  const nextDue = new Date(dueAt + s.interval_days * 86_400_000).toISOString();
  const { error: uErr } = await client
    .from("recurring_requests")
    .update({
      last_request_id: requestId,
      last_materialized_at: new Date().toISOString(),
      next_due_at: nextDue,
    })
    .eq("id", scheduleId)
    .eq("creator_id", auth.id);
  if (uErr) return err("db_error", uErr!.message);

  return { ok: true, data: { requestId, due: true, nextDueAt: nextDue } };
}
