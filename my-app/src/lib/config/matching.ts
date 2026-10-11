/**
 * Matching engine configuration — every knob for Phase 5 in one place.
 *
 * CHANGE POLICY:
 *  · Geo / ranking / paging constants below are product decisions and may be
 *    tuned freely.
 *  · Anything affecting *who counts as a possible donor* (eligibility,
 *    donation intervals, blood-group compatibility) must stay untouched
 *    until a qualified transfusion specialist approves a change. The
 *    compatibility model is hardcoded to EXACT MATCH ONLY and is not a
 *    tunable knob by design.
 */

export const MATCHING_CONFIG = {
  /** How few same-upazila candidates trigger tier-2 expansion. */
  MIN_LOCAL_CANDIDATES: 5,

  /** Max candidates returned per request (server-side hard cap). */
  PAGE_SIZE: 25,

  /**
   * Donor fatigue: max accepted-but-unconfirmed donation engagements in the
   * trailing window before a donor is demoted from the contactable pool.
   */
  FATIGUE_WINDOW_DAYS: 90,
  FATIGUE_MAX_ENGAGEMENTS: 3,

  /**
   * Only donors whose phone verification has actually succeeded are
   * contactable via any later reveal flow.
   */
  REQUIRE_VERIFIED_PHONE: true,

  /**
   * EXACT BLOOD-GROUP MATCH ONLY (master rule 11). Not configurable here on
   * purpose — changing it requires a qualified transfusion specialist.
   */
  COMPATIBILITY_MODEL: "exact" as const,

  /**
   * Privacy: donors' coordinates are never returned; only the coarse band
   * derived from the hierarchy relation (1=same upazila, 2=neighbouring
   * upazila, 3=same district, 4=adjacent district).
   */
  DISTANCE_BAND_MAX: 4,

  /**
   * Who may call matching: request owner or admins, enforced by service.
   */
  RESULT_INCLUDED_FIELDS: [
    "donor_user_id", "display_name", "blood_group",
    "upazila_name", "district_name", "availability", "tier",
  ] as const,
} as const;
