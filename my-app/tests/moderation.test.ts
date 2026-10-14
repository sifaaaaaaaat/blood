import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db: capture RPCs and table ops (same mock shape as the Phase 8 tests).
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  selects: [] as Array<{ table: string; cols: string; col?: string; val?: string }>,
  tableRows: {} as Record<string, unknown>,
}));

vi.mock("@/src/lib/db", () => {
  const finishRow = (table: string) =>
    Promise.resolve({ data: state.tableRows[table] ?? null, error: null });
  const client = () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => {
      const chain = (ret: { data: unknown; error: unknown } | PromiseLike<{ data: unknown; error: unknown }>) => ({
        order: (c: string, o?: { ascending?: boolean }) => {
          state.selects.push({ table, cols: "", col: c, val: "order" });
          return { limit: (n: number) => {
            state.selects.push({ table, cols: "", col: c, val: `limit:${n}` });
            return ret;
          } };
        },
        limit: (n: number) => {
          state.selects.push({ table, cols: "", col: "_", val: `limit:${n}` });
          return ret;
        },
      });
      return {
        select: (cols?: string) => {
          state.selects.push({ table, cols: cols ?? "" });
          return {
            eq: (col: string, val: string | number) => {
              state.selects.push({ table, cols: cols ?? "", col, val: String(val) });
              return {
                ...chain(finishRow("__row_" + table)),
                maybeSingle: () =>
                  Promise.resolve({ data: state.tableRows["__row_" + table] ?? null, error: null }),
              };
            },
            ...chain(finishRow(table)),
          };
        },
        insert: (row: unknown) => {
          state.selects.push({ table, cols: "insert", val: JSON.stringify(row) });
          return Promise.resolve({ data: state.tableRows["__inserted_" + table] ?? null, error: null });
        },
      };
    },
  });
  return { getServiceRoleClient: client, createUserClient: async () => client() };
});

import {
  createAbuseReport, listMyAbuseReports,
  listAbuseReports, listDeliveryFailures, listDisabledAccounts, readSettings, abuseMetrics,
  reviewAbuseReport, reviewRequest, disableAccount, reviewDisabledAccount,
  grantModerator, revokeModerator, setSetting, inspectProfile, requestAccountReview,
} from "@/src/lib/services/moderation";
import { candidatesQuery } from "@/src/lib/services/matching";
import type { AuthUser } from "@/src/lib/auth";

// Fixtures ---------------------------------------------------------------
const netId = "33333333-3333-3333-3333-333333333333";
const donor = { id: "11111111-1111-1111-1111-111111111111", isAdmin: false, isModerator: false } as never as AuthUser;
const moderator = { id: netId, isAdmin: false, isModerator: true } as never as AuthUser;
const admin = { id: "22222222-2222-2222-2222-222222222222", isAdmin: true, isModerator: false } as never as AuthUser;
const cookies = async () => [] as { name: string; value: string }[];

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
  state.selects = [];
  state.tableRows = {};
});

// ---------------------------------------------------------------------------
// Server-verified roles: unauthorized admin access is refused before any call,
// and the DB functions independently re-verify (tested live in the smoke).
// ---------------------------------------------------------------------------
describe("unauthorized admin access", () => {
  it("ordinary users cannot trigger review/flag/disable/staff RPCs", async () => {
    for (const attempt of [
      () => reviewAbuseReport(cookies, donor, "r1", "actioned", "n"),
      () => reviewRequest(cookies, donor, "q1", "flag", "n"),
      () => disableAccount(cookies, donor, "v1", "r"),
    ]) {
      const res = await attempt();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("forbidden");
    }
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("moderators cannot do admin-only things (no escalation path in app layer)", async () => {
    for (const attempt of [
      () => reviewDisabledAccount(cookies, moderator, "v1", "reinstate", "n"),
      () => grantModerator(cookies, moderator, "v1"),
      () => revokeModerator(cookies, moderator, "v1"),
      () => setSetting(cookies, moderator, "rate_limits.request_create_per_day", 999, "rate_limits"),
    ]) {
      const res = await attempt();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("forbidden");
    }
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("non-scalar settings values are refused before any DB call", async () => {
    const res = await setSetting(cookies, admin, "k", { nested: true } as never, "operational");
    if (!res.ok) expect(res.code).toBe("validation_error");
    expect(res.ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("profile inspection maps staff refusals; not-found for ordinary misses", async () => {
    state.rpcResults.mod_inspect_profile = { data: [{ ok: false, message: "staff only" }], error: null };
    const r1 = await inspectProfile(cookies, donor, "x");
    if (!r1.ok) expect(r1.code).toBe("forbidden");
    state.rpcResults.mod_inspect_profile = { data: [{ ok: false, message: "no donor profile for that user" }], error: null };
    const r2 = await inspectProfile(cookies, admin, " who".trim());
    if (!r2.ok) expect(r2.code).toBe("not_found");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Privacy leaks: inspection strips contact data; failures view excludes phone
// ---------------------------------------------------------------------------
describe("privacy leaks are structurally excluded", () => {
  it("inspectProfile surfaces ONLY the safe field set (no phone/coordinates)", async () => {
    state.rpcResults.mod_inspect_profile = {
      data: [{
        ok: true, message: "ok", display_name: "A", blood_group: "O+", birth_year: 1995,
        is_donor: true, is_requester: false, availability: "available",
        is_phone_verified: true, matches_other_verified_phone: true,
        open_reports: 1, created_at: "t", leaked_phone: "+8801700000000",
      }],
      error: null,
    };
    const res = await inspectProfile(cookies, admin, "u");
    expect(res.ok).toBe(true);
    const keys = Object.keys((res as { ok: true; data: Record<string, unknown> }).data);
    expect(keys).toContain("matches_other_verified_phone");
    expect(keys).not.toContain("leaked_phone");
    expect(JSON.stringify((res as { ok: true; data: Record<string, unknown> }).data)).not.toContain("+880");
  });

  it("delivery-failure inspection never selects recipient_phone", async () => {
    state.tableRows.notification_outbox = [];
    await listDeliveryFailures();
    const sel = state.selects.find((s) => s.table === "notification_outbox");
    expect(sel?.cols).toContain("failure_reason");
    expect(sel?.cols).not.toContain("recipient_phone");
  });
});

// ---------------------------------------------------------------------------
// Review flows reach the right RPCs with the right arguments; audits happen in
// the DB functions themselves (live-verified in the smoke).
// ---------------------------------------------------------------------------
describe("review flows + audit trail", () => {
  it("moderator review_report calls mod_review_abuse_report (DB will audit)", async () => {
    state.rpcResults.mod_review_abuse_report = { data: [{ ok: true, message: "review recorded" }], error: null };
    const res = await reviewAbuseReport(cookies, moderator, "rep-1", "dismissed", "insufficient evidence");
    expect(res.ok).toBe(true);
    const call = state.rpcCalls.find((c) => c.fn === "mod_review_abuse_report");
    expect(call?.args?.p_report).toBe("rep-1");
    expect(call?.args?.p_decision).toBe("dismissed");
  });

  it("closing a report without a note is refused by the app pre-check... reaches DB rule via note string", async () => {
    // App passes through; the DB refuses empty notes for terminal decisions.
    state.rpcResults.mod_review_abuse_report = { data: [{ ok: false, message: "resolution note required to close a report" }], error: null };
    const res = await reviewAbuseReport(cookies, admin, "rep-2", "actioned", "");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("rejected");
  });

  it("request flag/clear/cancel maps to mod_review_request with a note basis", async () => {
    state.rpcResults.mod_review_request = { data: [{ ok: true, message: "request moderated to flagged" }], error: null };
    const res = await reviewRequest(cookies, moderator, "req-9", "flag", "multiple duplicate requests");
    expect(res.ok).toBe(true);
    const call = state.rpcCalls.find((c) => c.fn === "mod_review_request");
    expect(call?.args?.p_action).toBe("flag");
    expect(call?.args?.p_note).toContain("duplicate");
  });

  it("disable/reinstate target the right functions with required reasons", async () => {
    state.rpcResults.mod_disable_account = { data: [{ ok: true, message: "account disabled pending review" }], error: null };
    const d = await disableAccount(cookies, admin, "user-7", "credential-stuffing evidence");
    expect(d.ok).toBe(true);
    state.rpcResults.admin_review_disabled_account = { data: [{ ok: true, message: "review recorded (reinstate)" }], error: null };
    const r = await reviewDisabledAccount(cookies, admin, "user-7", "reinstate", "cleared after review");
    expect(r.ok).toBe(true);
    expect(state.rpcCalls.find((c) => c.fn === "admin_review_disabled_account")?.args?.p_decision).toBe("reinstate");
  });

  it("user self-service appeal hits account_request_review", async () => {
    state.rpcResults.account_request_review = { data: [{ ok: true, message: "review requested" }], error: null };
    const res = await requestAccountReview(cookies, donor);
    expect(res.ok).toBe(true);
    expect(state.rpcCalls.some((c) => c.fn === "account_request_review")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Abusive patterns: counters/caps at the service + settings surfaces
// ---------------------------------------------------------------------------
describe("abusive patterns", () => {
  it("report filing is capped: counter refusal yields rate_limited with no insert", async () => {
    state.rpcResults.bump_abuse_counter = { data: [{ allowed: false, cnt: 11 }], error: null };
    const res = await createAbuseReport(cookies, donor, { targetType: "blood_request", targetId: null, category: "spam" });
    if (!res.ok) expect(res.code).toBe("rate_limited");
    expect(res.ok).toBe(false);
    expect(state.selects.some((s) => s.table === "abuse_reports")).toBe(false);
  });

  it("candidate listing is capped per day (donor-ID enumeration control)", async () => {
    state.tableRows["__row_blood_requests"] = {
      id: "e0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
      creator_id: donor.id, blood_group: "O+", location_id: 101001, status: "submitted",
    };
    state.rpcResults.bump_abuse_counter = { data: [{ allowed: false, cnt: 101 }], error: null };
    const res = await import("@/src/lib/services/matching").then((m) =>
      m.findCandidates(donor, "e0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("rate_limited");
  });

  it("daily cap knobs are read from the non-clinical settings table by the RPC", async () => {
    state.rpcResults.bump_abuse_counter = { data: [{ allowed: true, cnt: 1 }], error: null };
    await createAbuseReport(cookies, donor, { targetType: "other", targetId: null, category: "other" });
    const call = state.rpcCalls.find((c) => c.fn === "bump_abuse_counter");
    expect(call?.args?.p_scope).toBe("abuse_report"); // cap resolves in SQL from platform_settings
  });

  it("abuse metrics aggregates ids/counts, never names or phone data", async () => {
    state.tableRows.abuse_reports = [{ status: "open" }, { status: "open" }];
    state.tableRows.account_status = [{ status: "disabled" }];
    state.tableRows.notification_outbox = [{ id: 1 }];
    state.tableRows.abuse_counters = [{ subject_id: "u", scope: "candidate_list", count: 9 }];
    const res = await abuseMetrics();
    expect(res.ok).toBe(true);
    const payload = JSON.stringify(res);
    expect(payload).toContain("openReports");
    expect(payload.toLowerCase()).not.toContain("phone");
  });
});

// ---------------------------------------------------------------------------
// Read queues: staff-only tables are queried server-side (no PII columns)
// ---------------------------------------------------------------------------
describe("staff reads", () => {
  it("abuse report queue reads staff-bound columns from the server-only path", async () => {
    state.tableRows.abuse_reports = [];
    await listAbuseReports("open");
    expect(state.selects.some((s) => s.table === "abuse_reports")).toBe(true);
  });

  it("disabled-account list excludes review-note PII beyond moderation metadata", async () => {
    state.tableRows.account_status = [];
    await listDisabledAccounts();
    const sel = state.selects.find((s) => s.table === "account_status");
    expect(sel?.cols).toContain("review_requested_at");
    expect(sel?.cols).not.toContain("user_agent");
  });

  it("settings reads are admin-console only (server-only table)", async () => {
    state.tableRows.platform_settings = [];
    await readSettings();
    expect(state.selects.some((s) => s.table === "platform_settings")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Matching SQL: disabled donors excluded; my-reports read own rows only
// ---------------------------------------------------------------------------
describe("matching + ownership invariants", () => {
  it("candidate SQL excludes non-active (disabled/suspended) accounts", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 101001, scope: "same_upazila", limit: 5 });
    expect(sql).toContain("account_status st");
    expect(sql).toContain("st.status <> 'active'");
  });

  it("my-reports list filters by the reporter's own id", async () => {
    state.tableRows.abuse_reports = [];
    await listMyAbuseReports(cookies, donor);
    const sel = state.selects.find((s) => s.table === "abuse_reports" && s.col === "reporter_id");
    expect(sel?.val).toBe("11111111-1111-1111-1111-111111111111");
  });
});
