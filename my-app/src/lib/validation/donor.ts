import { z } from "zod";

/** Bangladeshi mobile in local or E.164 input; normalized to +880… server-side. */
const bdMobileInput = z
  .string()
  .trim()
  .regex(
    /^(?:\+?880|0)1[3-9]\d{8}$/,
    "must be a Bangladeshi mobile number (01XXXXXXXXX or +8801XXXXXXXXX)"
  );

export function normalizeBdMobile(input: string): string {
  const digits = input.replace(/\D/g, "");  // strip +, spaces, dashes
  // Accept 01XXXXXXXXX, 8801XXXXXXXXX, or +880 1XXXXXXXXX; canonicalize to
  // +880 + subscriber digits dropping the leading 0 (Bangladesh trunk prefix).
  const local = digits.replace(/^(?:880)?0?1/, "1");
  return "+880" + local;
}

/** B+ 33 years max on birth_year: age must be 16..100 at registration time. */
const thisYear = new Date().getUTCFullYear();
const birthYearSchema = z.number().int().min(thisYear - 100).max(thisYear - 16);

export const bloodGroups = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const;
export const bloodGroupSchema = z.enum(bloodGroups);

export const availabilitySchema = z.enum(["available", "paused"]);

export const upazilaRefSchema = z.object({
  division_id: z.number().int().min(1).max(99),
  district_id: z.number().int().min(1).max(999),
  upazila_id:  z.number().int().min(1).max(99999),
});

export const donorRegistrationSchema = z
  .object({
    display_name: z.string().trim().min(2).max(80),
    phone: bdMobileInput,
    blood_group: bloodGroupSchema,
    birth_year: birthYearSchema,
    location: upazilaRefSchema,
    availability: availabilitySchema.default("available"),
    last_donation_date: z
      .string()
      .date()
      .refine((d) => new Date(d) <= new Date(), "cannot be in the future")
      .optional(),
    // explicit notification consent; never default-true
    notify_consent: z.boolean(),
    notify_channel: z.enum(["in_app", "sms", "none"]).default("in_app"),
  })
  .strict()
  .refine((v) => !(v.notify_consent && v.notify_channel === "none"), {
    message: "consent given but channel is 'none'",
    path: ["notify_channel"],
  })
  .refine((v) => v.notify_consent || v.notify_channel === "none" || v.notify_channel === "in_app", {
    message: "sms channel requires explicit notify_consent",
    path: ["notify_channel"],
  });

export type DonorRegistrationInput = z.infer<typeof donorRegistrationSchema>;

export const donorUpdateSchema = z
  .object({
    display_name: z.string().trim().min(2).max(80).optional(),
    phone: bdMobileInput.optional(), // updates contact row, never display fields
    blood_group: bloodGroupSchema.optional(),
    birth_year: birthYearSchema.optional(),
    location: upazilaRefSchema.optional(),
    availability: availabilitySchema.optional(),
    last_donation_date: z
      .string()
      .date()
      .refine((d) => new Date(d) <= new Date(), "cannot be in the future")
      .optional(),
    notify_consent: z.boolean().optional(),
    notify_channel: z.enum(["in_app", "sms", "none"]).optional(),
    paused_until: z.string().date().optional(),
  })
  .strict()
  .refine(
    (v) =>
      !(v.notify_consent === true && v.notify_channel === "none") &&
      !(v.notify_channel === "sms" && v.notify_consent === false),
    { message: "incoherent notification consent/channel combination", path: ["notify_channel"] }
  );

export type DonorUpdateInput = z.infer<typeof donorUpdateSchema>;

export const donorProfileResponseSchema = z.object({
  display_name: z.string(),
  blood_group: bloodGroupSchema,
  birth_year: z.number().int(),
  division_id: z.number().int().nullable(),
  district_id: z.number().int().nullable(),
  upazila_id: z.number().int().nullable(),
  availability: availabilitySchema,
  paused_until: z.string().datetime().nullable(),
  last_donation_date: z.string().date().nullable(),
  notify_consent: z.boolean(),
  notify_channel: z.enum(["in_app", "sms", "none"]),
  is_phone_verified: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type DonorProfileResponse = z.infer<typeof donorProfileResponseSchema>;

/** STRICTEST test-relevant invariant: phone never leaves the owner's row. */
export const publicDonorSearchItemSchema = donorProfileResponseSchema
  .omit({ last_donation_date: true, notify_consent: true, notify_channel: true, is_phone_verified: true })
  .extend({ user_id: z.string().uuid() });

export type PublicDonorSearchItem = z.infer<typeof publicDonorSearchItemSchema>;
