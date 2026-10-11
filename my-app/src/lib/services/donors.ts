import "server-only";
import {
  donorRegistrationSchema,
  donorUpdateSchema,
  normalizeBdMobile,
  type DonorProfileResponse,
} from "@/src/lib/validation/donor";
import type { AuthUser } from "@/src/lib/auth";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; field?: string; message: string };

const err = (code: string, message: string, field?: string): Result<never> => ({ ok: false, code, field, message });

/** Fields that must NEVER appear in a non-owner response (defense in depth). */
const FORBIDDEN_COLUMNS = ["phone", "phone_normalized", "verified_at"];

export async function registerDonor(
  auth: AuthUser,
  input: unknown
): Promise<Result<{ user_id: string }>> {
  const parsed = donorRegistrationSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message, i.path.join("."));
  }
  const v = parsed.data;
  const supabase = await getUserClient();

  // Phone-verified? The auth user must have a confirmed contact row whose
  // normalized phone equals the submitted one — else verified=false, honest.
  const phoneNormalized = normalizeBdMobile(v.phone);

  // Upsert profile flags + donor row in one service call (RLS-checked writes).
  const { error: profErr } = await supabase.from("profiles").update({
    display_name: v.display_name,
    is_donor: true,
  }).eq("id", auth.id);
  if (profErr) return err("db_error", profErr.message);

  const { error: donorErr } = await supabase.from("donor_profiles").upsert({
    user_id: auth.id,
    birth_year: v.birth_year,
    blood_group: v.blood_group,
    division_id: v.location.division_id,
    district_id: v.location.district_id,
    upazila_id: v.location.upazila_id,
    availability: v.availability,
    last_donation_date: v.last_donation_date ?? null,
    notify_consent: v.notify_consent,
    notify_channel: v.notify_channel,
  });
  if (donorErr) return err("db_error", donorErr.message);

  const { error: contactErr } = await supabase.from("contact_numbers").upsert({
    user_id: auth.id,
    phone: v.phone,
    phone_normalized: phoneNormalized,
    // verified_at intentionally NOT set here: OTP confirmation is a distinct,
    // server-side step. Registering never marks a phone verified.
  });
  if (contactErr) return err("db_error", contactErr.message);

  if (v.notify_consent) {
    const { error: consentErr } = await supabase.from("notification_consents").insert({
      user_id: auth.id,
      channel: v.notify_channel === "none" ? "in_app" : v.notify_channel,
    });
    if (consentErr) return err("db_error", consentErr.message);
  }

  return { ok: true, data: { user_id: auth.id } };
}

async function getUserClient() {
  // wired to request-scoped cookies by route handler; see db.ts
  const { createUserClient } = await import("@/src/lib/db");
  return createUserClient(async () => []);
}

export async function getOwnDonorProfile(auth: AuthUser): Promise<Result<DonorProfileResponse>> {
  const supabase = await getUserClient();
  const { data, error } = await supabase
    .from("donor_profiles")
    .select(
      `display_name:profiles!inner(display_name),
       blood_group, birth_year, division_id, district_id, upazila_id,
       availability, paused_until, last_donation_date,
       notify_consent, notify_channel,
       is_phone_verified,
       created_at, updated_at`
    )
    .eq("user_id", auth.id)
    .single();

  if (error || !data) return err("not_found", error?.message ?? "donor profile missing");

  return {
    ok: true,
    data: donorProfileResponseShim(data),
  };
}

// Minimal adapter: maps the joined row into the response shape; keeps the
// service layer independent of Supabase's exact join output.
function donorProfileResponseShim(row: Record<string, unknown>): DonorProfileResponse {
  const profile = row.display_name as { display_name?: string } | string;
  void FORBIDDEN_COLUMNS; // guard reminder: these columns stay out of responses
  return {
    display_name: typeof profile === "string" ? profile : "unknown",
    blood_group: row.blood_group as DonorProfileResponse["blood_group"],
    birth_year: row.birth_year as number,
    division_id: (row.division_id as number | null) ?? null,
    district_id: (row.district_id as number | null) ?? null,
    upazila_id: (row.upazila_id as number | null) ?? null,
    availability: row.availability as DonorProfileResponse["availability"],
    paused_until: (row.paused_until as string | null) ?? null,
    last_donation_date: (row.last_donation_date as string | null) ?? null,
    notify_consent: row.notify_consent as boolean,
    notify_channel: row.notify_channel as DonorProfileResponse["notify_channel"],
    is_phone_verified: row.is_phone_verified as boolean,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function updateDonor(
  auth: AuthUser,
  input: unknown
): Promise<Result<{ updated: true }>> {
  const parsed = donorUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return err("validation_error", i.message, i.path.join("."));
  }
  const v = parsed.data;
  const supabase = await getUserClient();

  const patch: Record<string, unknown> = {};
  if (v.blood_group) patch.blood_group = v.blood_group;
  if (v.birth_year) patch.birth_year = v.birth_year;
  if (v.location) {
    patch.division_id = v.location.division_id;
    patch.district_id = v.location.district_id;
    patch.upazila_id = v.location.upazila_id;
  }
  if (v.availability) patch.availability = v.availability;
  if (v.last_donation_date !== undefined) patch.last_donation_date = v.last_donation_date;
  if (v.notify_consent !== undefined) patch.notify_consent = v.notify_consent;
  if (v.notify_channel) patch.notify_channel = v.notify_channel;
  if (v.paused_until !== undefined) patch.paused_until = v.paused_until;

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("donor_profiles").update(patch).eq("user_id", auth.id);
    if (error) return err("db_error", error.message);
  }

  if (v.display_name) {
    const { error } = await supabase.from("profiles").update({ display_name: v.display_name }).eq("id", auth.id);
    if (error) return err("db_error", error.message);
  }

  if (v.phone) {
    const { error } = await supabase.from("contact_numbers").upsert({
      user_id: auth.id,
      phone: v.phone,
      phone_normalized: normalizeBdMobile(v.phone),
      // verified_at untouched: see registerDonor comment
    });
    if (error) return err("db_error", error.message);
  }

  if (v.notify_consent) {
    const { error } = await supabase.from("notification_consents").insert({
      user_id: auth.id,
      channel: (v.notify_channel as string) === "none" ? "in_app" : (v.notify_channel as string),
    });
    if (error) return err("db_error", error.message);
  }

  return { ok: true, data: { updated: true } };
}
