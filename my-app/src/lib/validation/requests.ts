import { z } from "zod";

export const requestUrgencySchema = z.enum(["routine", "urgent", "critical"]);
export const requestStatusSchema = z.enum([
  "draft", "submitted", "searching", "awaiting_responses",
  "connected", "fulfilled", "cancelled", "expired", "flagged",
]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

export const contactPrefSchema = z.enum(["in_app", "sms", "phone_call"]);

/** Valid hand-set transitions (service-verified; DB layer keeps history only). */
export const ALLOWED_TRANSITIONS: Partial<Record<RequestStatus, RequestStatus[]>> = {
  draft:              ["submitted", "cancelled"],
  submitted:          ["searching", "cancelled", "expired", "flagged"],
  searching:          ["awaiting_responses", "cancelled", "expired", "flagged"],
  awaiting_responses: ["connected", "cancelled", "expired", "flagged"],
  connected:          ["fulfilled", "cancelled"],
  // terminal states have no outgoing edges
};

export const bloodRequestCreateSchema = z
  .object({
    blood_group: z.enum(["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"]),
    // hospital/pickup label; upazila_id refs the lookup table server-side
    hospital_name: z.string().trim().min(2).max(120),
    location: z.object({
      upazila_id: z.number().int().min(1).max(99999),
    }),
    location_text: z.string().trim().max(240).optional(),
    urgency: requestUrgencySchema.default("routine"),
    units_needed: z.number().int().min(1).max(20),
    required_by: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid datetime"),
    request_notes: z.string().trim().max(500).optional(),
    // The requester attests they may submit the given personal information.
    consent_confirmed: z.literal(true),
    contact_pref: contactPrefSchema.default("in_app"),
    idempotency_key: z.string().min(8).max(64),
  })
  .strict()
  .refine((v) => Date.parse(v.required_by) > Date.now() + 60_000, {
    message: "required_by must be at least 1 minute in the future",
    path: ["required_by"],
  });

export type BloodRequestCreateInput = z.infer<typeof bloodRequestCreateSchema>;

export const bloodRequestUpdateSchema = z
  .object({
    hospital_name: z.string().trim().min(2).max(120).optional(),
    location: z.object({ upazila_id: z.number().int().min(1).max(99999) }).optional(),
    location_text: z.string().trim().max(240).optional(),
    urgency: requestUrgencySchema.optional(),
    units_needed: z.number().int().min(1).max(20).optional(),
    required_by: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid datetime").optional(),
    request_notes: z.string().trim().max(500).optional(),
    contact_pref: contactPrefSchema.optional(),
  })
  .strict();

export type BloodRequestUpdateInput = z.infer<typeof bloodRequestUpdateSchema>;

/** What a non-owner sees — no contact info, no notes maybe containing PII. */
export const publicRequestItemSchema = z.object({
  id: z.string().uuid(),
  creator_id: z.string().uuid(),
  blood_group: z.enum(["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"]),
  hospital_name: z.string(),
  location_text: z.string().nullable(),
  urgency: requestUrgencySchema,
  units_needed: z.number().int(),
  required_by: z.string(),
  status: requestStatusSchema,
  created_at: z.string(),
});

export type PublicRequestItem = z.infer<typeof publicRequestItemSchema>;

/** Owner-visible response: adds internal fields but never other users' phones. */
export const ownerRequestItemSchema = publicRequestItemSchema.extend({
  location_id: z.number().int(),
  request_notes: z.string().nullable(),
  consent_confirmed: z.boolean(),
  contact_pref: contactPrefSchema,
  idempotency_key: z.string(),
  updated_at: z.string(),
  resolved_at: z.string().nullable(),
});
