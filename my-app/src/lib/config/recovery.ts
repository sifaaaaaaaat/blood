/**
 * Recovery-rule configuration (Phase 8).
 *
 * WHERE RULES LIVE: the actual exclusion windows live in the DATABASE
 * (public.recovery_rules) and can ONLY be activated through
 * admin_set_recovery_rule, which refuses to act without a named qualified
 * approver (approved_by_name) and a reference (approval_reference). There is
 * deliberately NO tunable day-count knob in this file: a hardcoded or
 * silently-edited recovery window is exactly what Phase 8 forbids.
 *
 * CHANGE POLICY:
 *  · Anything below that affects WHO is matched (fatigue caps) is a product
 *    knob and may be tuned.
 *  · Recovery windows (donation -> exclusion days) live in recovery_rules
 *    and require approval from a qualified local blood service or medical
 *    partner BEFORE they can be recorded. Never pre-author them here.
 *  · The platform never computes or stores "medical/clinical eligibility".
 *    Holds are ADMINISTRATIVE outreach holds; expiry asks the donor to
 *    confirm availability instead of auto-restoring matching.
 */

export const RECOVERY_CONFIG = {
  /** Donation types available for reporting. */
  DONATION_TYPES: ["whole_blood", "power_red", "plasma", "platelets"] as const,

  /** Allowed report back-dating window (configurable safety guard). */
  REPORT_BACKDATE_WINDOW_DAYS: 3650,

  /** Day tolerance for treating two reports of the same type as conflicting. */
  CONFLICT_DATE_TOLERANCE_DAYS: 3,

  /**
   * Repeated-request shielding: a donor is offered to at most this many NEW
   * matches in any 30-day window, on top of the Phase 5 connected-engagement
   * fatigue cap (FATIGUE_MAX_ENGAGEMENTS per 90 days).
   */
  MAX_NEW_MATCHES_PER_DONOR_30D: 8,

  /**
   * Approval gate: admin_set_recovery_rule refuses rows without BOTH a named
   * approver and a reference. This flag is documentation, not a bypass.
   */
  REQUIRES_QUALIFIED_APPROVER: true as const,
} as const;
