# Phase 12 — Deployment Readiness

Status: **NOT READY for production launch** (2 owner-gated approvals outstanding; messaging provider unconfigured). Everything below is verified against the real codebase and live database.

## 1. Required production environment variables

Set in the hosting platform (never in the repo):

| Variable | Purpose | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (browser-safe) | No |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key used by the RLS-bound session client | Browser-safe but rotate if leaked |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only client: audits, notification fan-out, admin RPCs | **Secret** |
| `SUPABASE_DB_PASSWORD` (ab) `SUPABASE_DB_HOST`, `SUPABASE_DB_PORT` | Direct Postgres (pooler) for migration script only | **Secret** |

Verified: the built output contains no secret *values*; the service key only travels through `server-only` modules (`src/lib/db.ts` requireEnv).

## 2. Database migration procedure

1. Take a Supabase backup (Dashboard → Database → Backups, or `pg_dump`).
2. Apply migrations **in numeric order**, each wrapped in a transaction (paths without begin/commit get a wrapper; `scripts/apply-migration.mjs` enforces transactionality by file rule):
   `MIGRATION_FILE=supabase/migrations/NNNN_*.sql node scripts/apply-migration.mjs`.
   Current set: `0001…0020` (latest: `0019` referrals, `0020` grant hardening).
3. Verify: `node scripts/apply-migration.mjs --verify` → expects RLS on every table, **44 RLS policies**, 5 triggers, core functions, and `admin_bootstrap_grant` hidden from anon/authenticated.
4. After migrations, confirm `node scripts/phase12-smoke.mjs` exits 0 (functional + security hot-check; safe to re-run anytime — it cleans up after itself).

Rollback: restore the pre-migration backup; migrations are additive and idempotent in structure, but no down-migrations exist.

## 3. Authentication provider setup (Supabase Auth)

- Magic-link email sign-in is the only credential path (`app/api/auth/magic-link` → `app/api/auth/callback`).
- In the Supabase console: set **Redirect URLs** to the exact production origin, configure production SMTP (the default Supabase email sender is rate-limited), enable email confirmation before launch.
- The app-side validation only accepts loopback/allow-listed origins — the callback check must be re-tested against the production origin after it's configured.

## 4. Messaging provider (SMS) — **not configured (intentional)**

- The notification provider is the approved **mock** implementation: enqueued notifications are marked `simulated_sent`; nothing leaves the platform.
- When a live provider is approved: implement the `SendOutcome`-compatible provider in `src/lib/providers/notification-provider.ts`, then:
  - add provider API credentials as server-only env vars (platform secret store, never committed);
  - **verify the provider's delivery-status webhook signature before trusting callbacks** (`processDeliveryStatus` trusts `providerRef` today — a live provider must get HMAC/signature validation first);
  - keep the `simulated` outbox flag: simulated rows can never be upgraded to `delivered`.
- Without explicit approval, the platform stays in mock mode.

## 5. Backup and recovery

- Supabase managed backups: enable daily backups + PITR **before launch**.
- Restore drill: at minimum verify `profiles`, `blood_requests`, `donation_records`, `audit_log` restoration.
- `.env.local` is the only store of secrets; keep it in the team's secret manager (it must never be committed).

## 6. Monitoring and error reporting

Currently **not wired** — gaps to close before launch:
- No error-reporting integration (Sentry or equivalent) — the app relies on JSON error envelopes.
- Built-in DB signals already available: `alert_repeated_failures` RPC (outbox health), outbox status counters surfaced by `/api/notifications/process`, `audit_log` rows for security-relevant events.
- Minimal pre-launch set: uptime probe on `/`, log drain from host + Supabase, and an alert on outbox `failed` count growth.

## 7. Privacy and data retention (owner approval required)

- Contact numbers are reveal-gated and audited (`contact_reveals` ledger, one-time action tokens, acceptance-only disclosure).
- Privacy-honest deletion removes donor availability/contact data and scrubs referral/schedule identifiers — but `blood_requests` history and `audit_log` rows persist.
- **Owner decision 1**: retention windows for `audit_log`, `contact_reveals`, `notification_outbox` (recommend a 90–180 day purge job).
- **Owner decision 2**: whether "Delete account" should fully purge request history (medical-adjacent data) or anonymize it.

## 8. Legal / clinical / policy approval — **still outstanding**

- Clinical donation-gap rules (95-day default) are staffed via `admin_set_recovery_rule` with a named medical approver + reference — no real approver recorded yet (smoke data uses a test name).
- Content pages (donation guide, FAQs, blog) are empty until approved copy exists — nothing is invented.
- Terms/privacy pages carry placeholder text pending owner wording.
- Referral attribution is a non-monetary recognition ledger only (no matching/eligibility influence) — confirm it meets local policy.

## 9. Test coverage summary (phase 12)

- Unit/API: **187 tests across 14 files** — all passing.
- Live: `scripts/phase12-smoke.mjs` — registration, request dedupe + expiry, tiered geo matching with consent/pause/enumeration-cap gating, accept/decline + impersonation refusal + double-accept refusal, contact reveal after acceptance + stranger refusal, donation-date validation, referral issue/redeem/idempotency/self-refusal, RLS on every table, no anon mutations, table-level bypass grants only for service_role, contact cross-user invisibility, revoke-audit trail, outbox idempotency index. **All PASS, exit 0.**
- Also live (earlier phases): phase6 e2e (acceptance/reveal races), phase7 (outbox), phase8 (recovery holds), phase10 (moderation).
