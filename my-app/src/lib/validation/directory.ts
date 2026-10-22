import { z } from "zod";

/**
 * Directory schemas (Phase 11C).
 *
 * Scope is directory ONLY (owner-approved): no inventory/stock fields exist.
 * Every bank record requires a mandatory provenance `sourceNote`.
 */

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const;
export const BANK_KINDS = ["hospital_bank", "transfusion_center", "ngo_org", "community_vault"] as const;

export const bloodBankSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,79}$/, "slug must be 3–80 chars of a-z0-9-");

const nameSchema = z.string().min(2).max(150);
const bnNameSchema = z.string().min(2).max(150);
const addressSchema = z.string().min(5).max(300);
const phoneSchema = z
  .string()
  .regex(/^[0-9+][0-9-]{6,15}$/, "phone may contain digits, +/- only")
  .optional()
  .or(z.literal("").transform(() => undefined));
const hoursSchema = z.string().min(3).max(200).optional().or(z.literal("").transform(() => undefined));
const sourceNoteSchema = z.string().min(4).max(240);
const groupsSchema = z
  .array(z.enum(BLOOD_GROUPS))
  .max(8)
  .optional()
  .transform((g) => Array.from(new Set(g ?? [])));

export const createBloodBankSchema = z.object({
  slug: bloodBankSlugSchema,
  name: nameSchema,
  nameBn: bnNameSchema.optional().or(z.literal("").transform(() => undefined)),
  kind: z.enum(BANK_KINDS).default("hospital_bank"),
  divisionId: z.coerce.number().int().positive(),
  districtId: z.coerce.number().int().positive(),
  upazilaId: z.coerce.number().int().positive().nullable().optional()
    .transform((u) => (u == null ? null : u)),
  address: addressSchema,
  groups: groupsSchema,
  phone: phoneSchema,
  openingHours: hoursSchema,
  sourceNote: sourceNoteSchema,
  publish: z.coerce.boolean().default(false),
});

export const updateBloodBankSchema = createBloodBankSchema
  .partial()
  .extend({ publish: z.coerce.boolean().optional() });

/**
 * What a signed-in user may PROPOSE for the directory. No slug (generated
 * server-side) and no publish flag (proposals always start unpublished).
 * Every other rule matches the blood_banks constraints the admin path uses.
 */
export const proposeBloodBankSchema = z.object({
  name: nameSchema,
  nameBn: bnNameSchema.optional().or(z.literal("").transform(() => undefined)),
  kind: z.enum(BANK_KINDS).default("hospital_bank"),
  divisionId: z.coerce.number().int().positive(),
  districtId: z.coerce.number().int().positive(),
  upazilaId: z.coerce.number().int().positive().nullable().optional(),
  address: addressSchema,
  phone: phoneSchema,
  openingHours: hoursSchema,
  sourceNote: sourceNoteSchema,
});

export type ProposeBloodBankInput = z.infer<typeof proposeBloodBankSchema>;

/** URL filter schema for the public directory (GET /api/blood-banks and page). */
export const bankFilterSchema = z.object({
  divisionId: z.coerce.number().int().positive().optional(),
  districtId: z.coerce.number().int().positive().optional(),
  group: z.enum(BLOOD_GROUPS).optional(),
  kind: z.enum(BANK_KINDS).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateBloodBankInput = z.infer<typeof createBloodBankSchema>;
export type UpdateBloodBankInput = z.infer<typeof updateBloodBankSchema>;
export type BankFilter = z.infer<typeof bankFilterSchema>;
