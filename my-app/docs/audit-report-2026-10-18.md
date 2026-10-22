# Production Readiness Audit — RoktoSathi (my-app)

**Date:** 2026-10-18 · **Auditor:** independent review · **Scope:** audit only (no fixes applied)
**Baseline:** branch `main`, HEAD `2fa0d3d` ("Phase 10"), plus ~50 untracked Phase 11/12 files and one modified file (`src/lib/db.ts` — restores the `createAuthedClient` export consumed by all auth routes).

---

## 1. Executive summary

The project has an unusually strong **design** layer: 20 additive SQL migrations with RLS on every table, an acceptance-gated contact-disclosure ledger, an idempotent notification outbox with a mock-only provider, server-side exact-blood-group matching with consent/verification/fatigue gating, and abuse rate limits. The intent and the guardrails documented in the code are good.

The **implementation state**, however, does not match that design today. A live smoke test against the dev server confirmed that **core write flows are broken**: request creation fails with `permission denied for table blood_requests`, donor profile retrieval 404s, and the same root cause blocks matching, notification fan-out, acceptance, and contact reveal. The cause is a refactor that replaced session-scoped Supabase clients with empty-cookie clients inside services (`createUserClient(async () => [])`). The 187-test suite passes 177 cases because tests stub the database client — they cannot catch this.

Separately, the **production build fails**, the **homepage and root layout are still the stock create-next-app scaffold** (the site Header/Footer exist but are never mounted), **no password recovery exists**, and **email confirmation is enabled without configured SMTP**, so real signups can never sign in (verified live).

The prior `docs/phase12-deployment-readiness.md` claims ("187 tests all passing", "magic-link is the only credential path") are **stale** and must not be relied on.

## 2. Overall readiness classification

## **NOT READY FOR DEPLOYMENT**

Confirmed defects and live evidence show broken core workflows (request creation, donor profile, and by the same cause matching/acceptance/notify), a failing production build, a missing user-facing shell, and no password recovery. None of these are hard to fix, but until they are fixed and re-verified end-to-end, the platform cannot serve real users.

The database design, privacy architecture, and notification architecture are the project's strengths and are largely reusable once the service-layer client wiring is repaired.

---

## 3. Repository and architecture inventory

| Area | State |
|---|---|
| Framework | Next.js **16.3.6** App Router, React 19.2.8, TypeScript 5 (strict), Tailwind 4, Zod 4, @supabase/ssr 0.12.7 |
| Runtime | Node v26.8.1, npm 11.19.0 (Windows host) |
| Tests | Vitest 5 (`tests/**/*.test.ts`, 14 files / 187 tests); **no `test` script in package.json** (`npx vitest run` only) |
| Git | Tracked = Phases 1–10; **untracked = all Phase 11/12 app code, 7 migrations, 8 test files, i18n, session.ts** |
| Pages | 19 routes in `app/` (about, bank, blog, camps, contact, directory, donate, faqs, login, notifications, /, privacy, profile, register, requests/[id|new], terms, thalassemia) |
| API routes | 38 route handlers in `app/api/**` — **plus 18 divergent duplicates under `src/app/api/**`** (Next uses root `app/`; `src/app` is dead, differing code) |
| Services | 16 modules in `src/lib/services/`; configs for matching/recovery/notifications |
| Migrations | `0001`–`0020` (last two untracked); ~44 RLS policies, ~40 Security-Definer functions (16/17 with `set search_path` in 0013), outbox + attempts audit tables, grant hardening (0020) |
| Auth | Supabase email+password (`/api/auth/signin|signup|signout`, live-verified); magic-link + callback routes still present as dead code |
| Env | `.env.local` present, gitignored, untracked (clean); **no `.env.example` committed** |
| Docs | `docs/phase12-deployment-readiness.md` (stale claims), `../docs/phase1-architecture.md` (proposal) |

### Duplicate route tree (detailed)
All 18 files under `src/app/api/**` differ from their `app/api/**` counterparts (e.g. `donors/register` differs in cookie handling). The root `app/` tree is the one Next compiles (build output references `./app/...`). `src/app/api` is untracked, unreachable, and divergent — an audit and maintenance hazard that must be deleted or reconciled.

### Dependency map (major)
- **Supabase Auth** ← signin/signup/signout/callback; session via `createAuthedClient` (next/headers) — verified working.
- **Service-role key** ← matching RPCs, outbox processing, moderation, stats, locations (server-only via `src/lib/db.ts`; not found in client bundles).
- **Notification outbox** ← fan-out (`fanOutMatchesForRequest`) → `claim_outbox_batch` RPC → mock provider; **no scheduler exists** (processing is triggered by `POST /api/notifications/process`).
- **Location seed** ← migration 0004 (3,697 lines) backs matching tiers and directory.

---

## 4. Feature-by-feature verification matrix

| Feature | Status | Evidence |
|---|---|---|
| Email+password signup | Verified working (live) | `POST /api/auth/signup` → 200; user created |
| Email confirmation | **Blocked in practice** | Project requires confirmation; no SMTP configured; sign-in then refuses (`invalid_credentials`) |
| Email+password signin | Verified working (live) | `POST /api/auth/signin` → 200 with session cookies |
| Signout | Verified working (live) | 303; subsequent `donors/me` → 401 |
| Password recovery | **Not implemented** | No `resetPasswordForEmail`/updateUser flow anywhere in `app/` or `src/` |
| Protected-page redirects | Verified working | `/requests/new` → `/login?next=/requests/new` (server-side) |
| Donor profile read | **Verified failing (live)** | `GET /api/donors/me` → 404 "Cannot coerce the result to a single JSON object" |
| Donor registration | **Verified failing** | Requires `phone` field; even with valid input the same client-wiring defect applies (donors.ts uses empty-cookie client) |
| Request creation | **Verified failing (live)** | `POST /api/requests` → 500 `permission denied for table blood_requests` |
| Request idempotency | Not tested (blocked) | Schema has `idempotency_key`; upstream creation broken |
| Matching candidates | Not tested (blocked upstream) | Code-reviewed: tiered expansion, exact group, caps present — but `assertCanMatch` reads via the broken empty-cookie client |
| Notify fan-out | Not tested (blocked upstream) | Same root cause (`fanOutMatchesForRequest` uses empty-cookie client) |
| Accept/decline + contact reveal | Code-reviewed only | `revealDonorContact` re-authorizes server-side; ledger + one-time tokens; **cannot be live-verified while upstream flows fail** |
| Notifications page | **Build broken** | imports `listOwnMatches` (not exported by `matching.ts`) |
| Request detail page | **Build broken** | imports `listRequestTransitions`, `listRequestMatches` (not exported) |
| Blood-bank directory | Renders (360px, live) | no overflow; search input present; data service reviewed |
| Blood camps / FAQ / blog / donate | Render (live, 200) | content pages empty by design pending approved copy |
| Admin/moderation | Code-reviewed only | `getAuthUser` + DB re-verification pattern; **not live-verified (no admin account)** |
| Recurring schedules | Code + unit tests only | arg-count mismatch (`recurring.ts:269`) — one materialize path fails type check |
| Language switching | **Broken UX** | bn/en dictionaries complete and parity-tested, but the Header that hosts the switcher is never rendered; `lang="en"` hardcoded in layout |
| Referrals | Deferred (Phase 9) | 0019 migration + service exist; acknowledged non-monetary ledger |

---

## 5. Quality-gate results (actual commands, actual exit codes)

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | **FAIL (exit 2)** — 19 errors; all in service/route/test mismatches (missing exports `listOwnMatches`, `createMatchesFromCandidates`, `listRequestMatches`, `listRequestTransitions`; `phone` field; arg counts). Auth/i18n layers clean. |
| Unit tests | `npx vitest run` | **FAIL (exit 1)** — 177/187 pass; 10 failures in 3 files, all the same service-gap family |
| Lint | `npx eslint .` | **PASS** — 0 errors, 13 warnings (unused vars, import style) |
| Production build | `npx next build` | **FAIL (exit 1)** — unresolved imports in `/notifications`, `/requests/[id]`, `/api/matches*`, `/api/requests/[id]/matches` |
| Dependency audit | `npm audit --omit=dev` | **2 high**: `next` (Draft-Mode `use cache` leak advisory), `sharp` (librsvg CVE-2026-96889) — fixable by patch/minor upgrades |
| Secret scan | repo-wide regex scan | **Clean** — only env-var *names* found; `.env.local` ignored; nothing tracked |
| Live smoke | dev-server curl/fetch flows | Signup/signin/signout OK; `donors/me` 404; `POST /api/requests` 500 (test user created and deleted afterward) |

**Note on test honesty:** the suite's passing cases use in-memory stub clients and never exercise the real RLS-path client wiring — that is why 177 tests pass while the live API is broken. This is a test-architecture gap, not a green light.

---

## 6. Security findings

### A-AUTH-1 (P1, confirmed) — Email confirmation enabled, no SMTP configured
Evidence: live signup returned `confirmation_sent_at`; sign-in then refused. Supabase's built-in sender is rate-limited and unsuitable for a pilot. **Remediation:** configure production SMTP in Supabase before any real signup, or disable confirmation for the pilot and document it.

### A-AUTH-2 (P1, confirmed by absence) — No password recovery
For an email+password product this is a launch blocker (P1). Remediation: implement `resetPasswordForEmail` + reset page + route, with same-origin redirect validation.

### A-AUTH-3 (P2, verified by design) — Anti-enumeration sign-in errors
`invalid_credentials` covers both wrong-password and unconfirmed-email. Privacy-positive, but the unconfirmed user gets no hint to confirm; pair with a resend-confirmation flow.

### A-AUTH-4 (P2, verified) — Session handling
Cookies handled by Supabase SSR client; signout invalidates (live-verified). No middleware exists; protected pages rely on server-side redirects (verified) and every route handler re-checks `getAuthUser` (code-verified across 38 routes). Acceptable, but document the pattern; add middleware later for defense-in-depth.

### A-DB-1 (P1, verified statically) — Service-layer DB identity mismatch (root cause of Section 4 failures)
`createUserClient(async () => [])` in `matching.ts`, `requests.ts`, `fanout.ts`, `donors.ts` runs RLS-restricted queries as the **anon** role: `blood_requests` SELECT policy is `to authenticated` only, and table grants are revoked from anon — hence "permission denied" and coerced-empty results. This is a correctness defect first; it is listed under security because the *fix* must preserve the ownership checks (several services compensate with manual `auth.id` comparisons — correct but must be re-verified after repair).

### A-DB-2 (P2, verified statically) — SQL-string gateways
`exec_matching_sql` / `exec_location_sql` execute SQL strings built by the app. Mitigations are real (service-role-only execution, SELECT-only regex, mandatory `donor_profiles`/`upazilas` FROM clause, private-column denylist, fixed return shape). Regex SQL filtering is brittle defense-in-depth; recommend replacing with parameterized functions before scale. Not exploitable by anon/authenticated roles (execute revoked).

### A-DB-3 (verified good) — RLS posture
No `FOR ALL to public` policies; sensitive tables (outbox, attempts, tokens) have RLS on with **zero** policies (service-role only) and grants revoked from `anon, authenticated`; 0020 hardens table-level grants; Security-Definer functions set `search_path`. Contact data is protected at both DB and service layers. Live forbidden-access tests were **not** re-run in this audit (blocked: would need live write-capable flows); the prior smoke claims are stale and must be re-verified after repairs.

### A-WEB-1 (P2, verified) — Open-redirect hygiene
`next` params validated against a same-origin relative-path regex in login/register/callback. Good. Callback route is currently dead code.

### A-WEB-2 (P3, potential) — In-memory abuse windows
`checkCreateRate` uses a per-process Map: lost on restart, not shared across instances. Durable DB-side counter exists (`bump_abuse_counter`) — fine for single-instance pilot.

### A-SEC-ENV (verified good) — Secrets
Service-role key referenced only in server-only modules; no values in tracked files or bundles; `.env.local` untracked. Keep it that way; add `.env.example` (names only) for reproducibility.

### A-DEP-1 (P2) — 2 high dependency advisories (`next`, `sharp`)
Upgrade within minor/patch ranges after verifying against the Next 16 docs (repo warns Next 16 has breaking changes). Do not bulk-upgrade.

---

## 7. Donor privacy and contact-disclosure findings

- **Verified good (code):** candidates expose only safe display fields (`MATCHING_CONFIG.RESULT_INCLUDED_FIELDS`; no phone/coordinates); the SQL gateway rejects private columns; phone verification (`cn.verified_at is not null`) is a hard filter for contactability; contact reveal requires an accepted match + verified phone + audited `contact_reveals` ledger with one-time tokens; donors can pause and set consent; disabled/flagged donors are excluded.
- **P2 — retention undefined:** `audit_log`, `contact_reveals`, `notification_outbox` have no retention/purge policy. Owner decision required (docs suggest 90–180 days).
- **P2 — deletion semantics:** account deletion removes availability/contact data but request history and audit rows persist. Under Bangladesh's **Personal Data Protection Act 2026 (Act No. 63 of 2026)**, health-related data is sensitive and erasure rights apply — obtain local legal guidance before launch; the platform must not self-certify compliance.
- **P3 — location precision:** hierarchy-based bands only (no coordinates) — good; keep it that way.
- **Blocked verification:** "public search never exposes phone numbers" could not be live-retested while flows are broken.

## 8. Matching logic and medical boundaries

- **Verified good (code):** exact blood-group only (`COMPATIBILITY_MODEL: "exact"`, deliberately non-configurable); four-tier location expansion (same upazila → neighbouring → same district → adjacent) with caps; fatigue window (3 engagements/90 days); recovery holds exclude donors until *donor-confirmed* lift (expiry never auto-restores); consent + verified phone + availability + paused_until all enforced in SQL; enumeration rate cap via audited RPC.
- **P1 (deploy-gate):** the 95-day recovery default and any clinical rules require a **named medical approver** via `admin_set_recovery_rule` — none recorded; treat as a launch blocker for real use.
- **P2 (verified):** UI copy must continue to state that a match is not clinical compatibility clearance; keep the honest-empty-states behavior when tiers return nothing.
- **Untestable now:** concurrent accept/reveal races (phase6 e2e exists but could not be re-run meaningfully while upstream flows fail).

## 9. Integration and notification readiness

| Integration | Status |
|---|---|
| Supabase (auth + DB) | Configured (dev project); **SMTP missing** → signup confirmation blocked |
| SMS/WhatsApp provider | **Mock only** (deliberate, policy-documented: Meta blood-donation restriction noted in code); outbox marks `simulated_sent`; no real delivery |
| Maps/geo | None external — local adjacency tables (good) |
| File storage | Not used |
| Error reporting/monitoring | **Not wired**; outbox health RPC + audit log exist as building blocks |
| Scheduled jobs | **None** — outbox processing requires calling `POST /api/notifications/process` (cron/scheduler must be arranged at deploy) |
| Email delivery (transactional) | N/A until recovery flow exists |

**P1:** for a real pilot, donors will never learn about matches under mock mode — an approved communication plan (provider or manual operator process) is required before launch.

## 10. Database integrity and recovery

- **Verified good (static):** additive, transactional migrations; unique constraints incl. `idempotency_key` on outbox; FK cascade on profile rows; partial indexes for outbox sweeps; grant-hardening migration; apply script enforces transactionality and a `--verify` mode (44 policies / 5 triggers expected).
- **P1 — untracked migrations:** 0014–0020 are not in git; losing the working tree loses the schema history.
- **Blocked/not evidenced:** backup policy, restore drill, prod DB drift check — no production access in this audit. The docs' "live DB verified" claims predate the current broken code and cannot be trusted without a re-run of `phase12-smoke.mjs` after repairs.

## 11. Performance and reliability

- Matching runs entirely in Postgres with caps (25/page) and partial indexes — sound shape. N+1 risk: none observed in reviewed services; the fan-out loop is sequential per match (acceptable at pilot scale; batch later).
- **P2:** no scheduler for outbox; **P3:** in-memory rate windows (A-WEB-2); **P3:** `stats.ts` uses service-role for public counters — fine, but cache it.
- Failure behavior: DB errors surface as JSON envelopes (good); no retry storms possible yet (no background loops). Restart during processing is covered by the sending-heartbeat recovery design (unverified live).

## 12. UI, accessibility, cross-device

- **Verified (360px, live DOM):** `/`, `/login`, `/register`, `/directory` — no horizontal overflow; login/register forms render correct fields; bn content renders; protected-route redirect works; no console errors.
- **P1 (verified):** root layout + homepage are the **stock create-next-app scaffold** ("Create Next App" title; `next.svg`; "Deploy Now"). The Header/Footer components (`src/components/site/`) are imported by nothing — users get **no navigation at all** except in-page links; the language switcher and login/profile entry points in the Header are unreachable.
- **P2:** `lang="en"` hardcoded while bn content can render (SEO/a11y).
- **Not tested (honest):** 390/768/1024/1440px, screen readers, keyboard-only flows, contrast — screenshot tooling was unavailable this session; only DOM-level checks were possible.

## 13. Production configuration checklist (order of operations for a future deploy)

1. Commit all untracked work (code + migrations) to git; delete/reconcile `src/app/api`.
2. Fix the service-layer client wiring (A-DB-1) so every service gets the caller's session cookies; restore missing service exports (build blockers).
3. Implement password recovery; wire SMTP; align Supabase Redirect URLs with the production origin.
4. Mount the site shell (Header/Footer) in `app/layout.tsx`; replace the scaffold homepage/layout metadata; fix `lang` handling.
5. Re-run `tsc` (0 errors), `vitest` (187/187), `next build` (0 errors) as a merge gate; then re-run `phase12-smoke.mjs` against a staging DB to re-establish the live security evidence.
6. Configure production env (4 vars from the readiness doc), enable daily backups + PITR, perform a restore drill on staging.
7. Schedule the outbox processor (cron) + uptime probe + failed-outbox alert; add error reporting.
8. Owner approvals: medical recovery rules (named approver), retention windows, deletion semantics, legal review under PDPA 2026, communication provider decision.
9. Record an admin bootstrap procedure; verify admin grant is not assignable by ordinary users (policy verified statically; re-verify live).
10. Deploy to a staging URL first; run the full Stage-3 journey list before any public traffic.

## 14. External approvals and unresolved dependencies

- Medical approver + recovery-rule values (P1 launch gate) — human approval.
- Live notification provider or documented manual process (P1) — owner decision.
- Legal review: PDPA 2026 consent/retention/erasure posture (P2) — legal counsel.
- Approved content copy (FAQs/blog/guide), terms/privacy wording — owner.
- Production SMTP + redirect URLs — configuration.
- Monitoring/backup/restore arrangements — ops setup.

## 15. Prioritized remediation backlog

| ID | Sev | Item |
|---|---|---|
| F-01 | **P0** | Fix service-layer session wiring (`createUserClient(async () => [])` → caller's cookies / `createAuthedClient`); verify request creation, donors/me, matching, fan-out, reveal end-to-end (repro: live smoke steps in §5) |
| F-02 | **P1** | Restore missing service exports consumed by routes/tests/pages; make `next build` pass |
| F-03 | **P1** | Password recovery flow (request + reset pages + `resetPasswordForEmail`) |
| F-04 | **P1** | Mount Header/Footer in layout; replace scaffold homepage/layout; fix `lang` |
| F-05 | **P1** | Configure Supabase SMTP (or disable confirmation for pilot) + production Redirect URLs |
| F-06 | **P1** | Commit all untracked work; delete divergent `src/app/api` tree; add `.env.example` (names only) |
| F-07 | **P1** | Medical approver + recovery rules before real donors are matched |
| F-08 | **P1** | Approved communication process for donor notifications |
| F-09 | **P2** | Patch `next`/`sharp` advisories; add `npm audit` to CI; add `test` script to package.json |
| F-10 | **P2** | Make the test suite exercise the real Supabase client path (integration tests against staging DB) so client-wiring regressions cannot recur silently |
| F-11 | **P2** | Retention policy + purge job for audit_log/contact_reveals/outbox; deletion semantics decision |
| F-12 | **P2** | Monitoring: uptime probe, outbox failed-count alert, error reporting (Sentry or equivalent) |
| F-13 | **P2** | Legal review under PDPA 2026; privacy policy wording; donor data-flow documentation |
| F-14 | **P3** | Remove dead code (MagicLinkForm, magic-link/callback routes, `src/app`); replace regex SQL gateways with parameterized functions; durable rate-limit store; fix stale phase12 doc claims; bn copy cleanup (mixed-language subtitles) |

## 16. Recommended staging & controlled-pilot plan

1. **Repair sprint** (F-01…F-06) on a branch; merge only when tsc/vitest/build are green.
2. **Staging deploy** with fresh migrations from 0001→0020; run phase12-smoke + full journey tests (signup→confirm→register→request→match→accept→reveal→donation record).
3. **Pilot gate:** medical approver recorded; notification path decided; backups + restore drill done; monitoring live.
4. **Controlled pilot:** single region (one district), invite-only donors, mock or manual notification until provider approval, weekly outbox/audit review, published honest limitations page.
5. **Exit criteria to READY FOR CONTROLLED PILOT:** all P0/P1 items closed with re-verified evidence; P2 privacy items scheduled with owner decisions recorded.

---

### Verification-status buckets (final)

- **Verified working:** signup/signin/signout (live), session persistence, protected redirects, RLS policy structure, outbox design, matching config, contact-reveal gating (code), i18n parity, lint, secret hygiene.
- **Verified failing (live/build):** request creation, donors/me, donor registration validation chain, notifications & request-detail pages, production build, site shell/homepage, email-confirmation path.
- **Not tested:** matching/accept/reveal end-to-end, admin flows, prod DB, backups/restore, viewports beyond 360px, screen readers.
- **Blocked by unavailable configuration:** SMTP, live SMS provider, production access.
- **Mocked/simulated:** all notification delivery.
- **Requires human/external approval:** clinical rules, retention/deletion policy, legal compliance, provider selection.
