/**
 * Notification architecture configuration (Phase 7).
 *
 * CHANGE POLICY:
 *  · PROVIDER stays pinned to "mock" until the WhatsApp Business eligibility
 *    question is resolved with Meta / an authorized provider AND the owner
 *    explicitly authorizes going live. Do NOT flip this switch casually.
 *  · BATCH_SIZE / MAX_ATTEMPTS / PER_DONOR_PENDING_LIMIT are operational
 *    product knobs and may be tuned.
 *  · Message CONTENT rules (never leak donor phone in links, never fabricate
 *    delivery receipts) are hard rules, not knobs.
 */

export const NOTIFICATION_CONFIG = {
  /**
   * Active provider. "mock" records simulated attempts only and NEVER marks
   * anything delivered. Pinned until WhatsApp eligibility is confirmed.
   */
  PROVIDER: "mock" as const,

  /** Simulated attempts carry this marker in every completed outbox row. */
  SIMULATED_MARKER: "simulated_sent" as const,

  /** Outbox rows claimed per processing sweep. */
  BATCH_SIZE: 20,

  /** Hard cap on attempts before an item is marked failed (bounded retry). */
  MAX_ATTEMPTS: 5,

  /** Exponential backoff base in minutes: 2, 4, 8, 16, ... capped. */
  BACKOFF_BASE_MINUTES: 2,

  /** Queue TTL: stale queued/sending rows older than this are expired. */
  STALE_TTL_HOURS: 6,

  /** Per-donor fairness: max PENDING outbox rows per recipient per sweep. */
  PER_DONOR_PENDING_LIMIT: 5,

  /**
   * Action links embedded in notifications use this TTL. Short-lived by
   * policy: links must not outlive the request urgency.
   */
  ACTION_TOKEN_TTL_MINUTES: 30,

  /**
   * Items stuck in "sending" longer than this (process crash) are recovered
   * back to queued by the sweeper.
   */
  SENDING_HEARTBEAT_STALE_MINUTES: 10,

  /**
   * Monitoring: more than this many 'failed' rows for one request raises an
   * audit-log alert (repeated-failure signal).
   */
  REPEATED_FAILURE_ALERT_THRESHOLD: 3,
} as const;
