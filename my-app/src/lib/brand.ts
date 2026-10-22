/**
 * Central brand configuration (Phase 11B).
 *
 * `RoktoSathi` is the TEMPORARY working name until a final brand is chosen
 * (product-owner decision pending). Trademark / domain availability has NOT
 * been verified and no claim may be made that it has.
 *
 * Nothing here invents contact details, legal approvals or affiliations —
 * those fields stay empty until the owner supplies real approved copy.
 */
export const BRAND = {
  /** Temporary working name — swap centrally when the final brand lands. */
  name: {
    en: "RoktoSathi",
    bn: "রক্তসাথী",
  } as Record<"en" | "bn", string>,

  tagline: {
    en: "Connecting voluntary blood donors with patients across Bangladesh",
    bn: "বাংলাদেশে স্বেচ্ছায় রক্তদাতা ও রোগীকে সংযুক্ত করছি",
  } as Record<"en" | "bn", string>,

  /** Short description for metadata & og tags. */
  description: {
    en: "Find voluntary blood donors near you in Bangladesh. Request blood, discover blood banks and camps, and learn about safe donation.",
    bn: "বাংলাদেশে আপনার কাছাকাছি স্বেচ্ছাসেবী রক্তদাতা খুঁজুন। রক্ত চান, ব্লাড ব্যাংক ও ক্যাম্প খুঁজুন এবং নিরাপদ রক্তদান সম্পর্কে জানুন।",
  } as Record<"en" | "bn", string>,
} as const;

/** All support/legal facts must come from the owner; nothing fabricated here. */
export const LEGAL_STATUS = {
  /** No physical address, phone, or registration number has been provided yet. */
  contactProvided: false,
  /** No government affiliation, endorsement, or partnership claim may be shown. */
  officialEndorsement: false,
} as const;
