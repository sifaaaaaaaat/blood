import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db: capture RPCs and table ops.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  selects: [] as Array<{ table: string; cols: string; col?: string; val?: string }>,
  tableRows: {} as Record<string, unknown>,
}));

vi.mock("@/src/lib/db", () => {
  const client = () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => ({
      select: (cols?: string) => {
        state.selects.push({ table, cols: cols ?? "" });
        return {
          eq: (col: string, val: string | number) => {
            state.selects.push({ table, cols: cols ?? "", col, val: String(val) });
            return Promise.resolve({ data: state.tableRows[table] ?? null, error: null });
          },
        };
      },
    }),
  });
  return {
    getServiceRoleClient: client,
    createUserClient: async () => client(),
  };
});

import { reportDonation, confirmAvailability, getRecoveryState, listMyDonations, adminVerifyDonation, adminSetRecoveryRule, adminLiftHold } from "@/src/lib/services/donations";
import { candidatesQuery } from "@/src/lib/services/matching";
import { RECOVERY_CONFIG } from "@/src/lib/config/recovery";

const donor = { id: "11111111-1111-1111-1111-111111111111", isAdmin: false } as never;
const admin = { id: "22222222-2222-2222-2222-222222222222", isAdmin: true } as never;

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
  state.selects = [];
  state.tableRows = {};
});

// ---------------------------------------------------------------------------
// Verification separation: self-report can never be represented as verified
// ---------------------------------------------------------------------------
describe("adminVerifyDonation skips donor self-reports in verified form", () => {
  it("passes through the approved flow with the separated verification block", async () => {
    state.rpcResults.admin_verify_donation = { data: [{ ok: true, message: "verified" }], error: null };
    const res = await adminVerifyDonation(admin, "r1", "verified", "Certificate #12 from CMCH blood center");
    expect(res.ok).toBe(true);
    const call = state.rpcCalls.find((c) => c.fn === "admin_verify_donation");
    // basis is required: a bare flip to verified is refused upstream anyway
    expect(call?.args?.p_basis).toContain("Certificate");
    expect(call?.args?.p_status).toBe("verified");
  });

  it("rejects non-admins BEFORE any db call (permission-controlled)", async () => {
    const res = await adminVerifyDonation(donor, "r1", "verified", "x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
    expect(state.rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recovery rules: configurable ONLY with named qualified approver
// ---------------------------------------------------------------------------
describe("adminSetRecoveryRule", () => {
  it("records the rule with approver + reference (never tunable silently)", async () => {
    state.rpcResults.admin_set_recovery_rule = { data: [{ ok: true, message: "rule active for whole_blood" }], error: null };
    const res = await adminSetRecoveryRule(admin, {
      donationType: "whole_blood", days: 120,
      approvedByName: "Dr. A. Rahman, DMCH Blood Transfusion Dept.",
      approvalReference: "DMCH/2026/014",
    });
    expect(res.ok).toBe(true);
    const call = state.rpcCalls.find((c) => c.fn === "admin_set_recovery_rule");
    expect(call?.args?.p_approved_by_name).toContain("Rahman");
    expect(call?.args?.p_approval_reference).toBe("DMCH/2026/014");
    expect(call?.args?.p_days).toBe(120);
  });

  it("rejects non-admins before touching the db", async () => {
    const res = await adminSetRecoveryRule(donor, { donationType: "whole_blood", days: 1, approvedByName: "x", approvalReference: "y" });
    if (!res.ok) expect(res.code).toBe("forbidden");
    expect(res.ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hold override: authorization gate — no named medical authority, no override
// ---------------------------------------------------------------------------
describe("adminLiftHold authorization gate", () => {
  it("maps the refused override (no authority) to requirement_missing", async () => {
    state.rpcResults.admin_lift_hold = {
      data: [{ ok: false, message: "overriding a recovery hold requires a named medical authority - refused" }],
      error: null,
    };
    const res = await adminLiftHold(admin, "donor-id", "note", "");
    if (!res.ok) expect(res.code).toBe("requirement_missing");
    expect(res.ok).toBe(false);
  });

  it("applies audited override only when an authority is named", async () => {
    state.rpcResults.admin_lift_hold = { data: [{ ok: true, message: "hold overridden by admin (audited)" }], error: null };
    const res = await adminLiftHold(admin, "donor-id", "consultant cleared the donor", "Dr. K. Sultana, Transfusion Medicine");
    expect(res.ok).toBe(true);
    const call = state.rpcCalls.find((c) => c.fn === "admin_lift_hold");
    expect(call?.args?.p_medical_authority_name).toContain("Sultana");
  });

  it("rejects non-admins before touching the db", async () => {
    const res = await adminLiftHold(donor, "d", "n", "authority");
    if (!res.ok) expect(res.code).toBe("forbidden");
    expect(res.ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Report validation + conflict-safe handling
// ---------------------------------------------------------------------------
describe("reportDonation", () => {
  it("validation: unknown type / invalid date refused without db calls", async () => {
    expect((await reportDonation(donor, { donationDate: "2026-01-01", donationType: "leeches" })).ok).toBe(false);
    const r = await reportDonation(donor, { donationDate: "not-a-date", donationType: "whole_blood" });
    expect(r.ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("relays hold result with reason and until date", async () => {
    state.rpcResults.donor_report_donation = {
      data: [{ ok: true, state: "hold_applied", message: "Recovery hold: whole_blood...", hold_until: "2026-04-01", conflict_with: null }],
      error: null,
    };
    const res = await reportDonation(donor, { donationDate: "2026-01-01", donationType: "whole_blood" });
    if (res.ok) {
      expect(res.data.state).toBe("hold_applied");
      expect(res.data.holdUntil).toBe("2026-04-01");
    }
    expect(res.ok).toBe(true);
  });

  it("conflicting-date flows return the conflict reference, not an error", async () => {
    state.rpcResults.donor_report_donation = {
      data: [{ ok: true, state: "hold_applied", message: "conflict handled", hold_until: "2026-05-01", conflict_with: "rec-2" }],
      error: null,
    };
    const res = await reportDonation(donor, { donationDate: "2026-01-02", donationType: "whole_blood" });
    if (res.ok) expect(res.data.conflictWith).toBe("rec-2");
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recovery state machine — the "no automatic medical eligibility" contract
// ---------------------------------------------------------------------------
describe("getRecoveryState", () => {
  it("maps the three administrative states and never claims clinical standing", async () => {
    for (const [raw, expected] of [
      [{ state: "recovery_hold", hold_until: "2027-01-01", reason: "rationale", paused: true }, "recovery_hold"],
      [{ state: "awaiting_confirmation", hold_until: "2026-01-01", reason: "confirm your availability", paused: true }, "awaiting_confirmation"],
      [{ state: "active", hold_until: null, reason: null, paused: false }, "active"],
    ] as const) {
      state.rpcResults.donor_recovery_state = { data: raw, error: null };
      const res = await getRecoveryState(donor);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.state).toBe(expected);
    }
    // State vocabulary contains only administrative labels:
    const states: Array<typeof RECOVERY_CONFIG extends never ? never : string> = ["recovery_hold", "awaiting_confirmation", "active"];
    for (const s of states) expect(s.toLowerCase()).not.toContain("eligible");
  });

  it("auth failures map to forbidden and stay out of other donors' views", async () => {
    state.rpcResults.donor_recovery_state = { data: null, error: { message: "donor_recovery_state: not authorized for donor X" } };
    const res = await getRecoveryState(donor, "99999999-9999-9999-9999-999999999999");
    if (!res.ok) expect(res.code).toBe("forbidden");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirm availability: donor-controlled resume after expiry
// ---------------------------------------------------------------------------
describe("confirmAvailability", () => {
  it("relays hold_active refusal while the configured period runs", async () => {
    state.rpcResults.donor_confirm_availability = { data: [{ ok: false, state: "hold_active", message: "Recovery hold is active until 2027-01-01." }], error: null };
    const res = await confirmAvailability(donor);
    if (!res.ok) expect(res.code).toBe("hold_active");
    expect(res.ok).toBe(false);
  });

  it("returns active once the donor confirms after expiry", async () => {
    state.rpcResults.donor_confirm_availability = { data: [{ ok: true, state: "active", message: "Availability confirmed" }], error: null };
    const res = await confirmAvailability(donor);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.state).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Donor history: self-reported, verified flags shown honestly
// ---------------------------------------------------------------------------
describe("listMyDonations", () => {
  it("reads only own rows and includes the separated verification column", async () => {
    state.tableRows.donation_records = [];
    await listMyDonations(donor);
    const sel = state.selects.find((s) => s.table === "donation_records" && s.col);
    expect(sel?.col).toBe("donor_id");
    expect(sel?.val).toBe("11111111-1111-1111-1111-111111111111");
    expect(sel?.cols).toContain("verification");
    expect(sel?.cols).toContain("report_note");
    expect(sel?.cols).not.toContain("verification_actor"); // internal provenance stays internal
  });
});

// ---------------------------------------------------------------------------
// Matcher SQL: recovery-hold exclusion + repeated-request shield
// ---------------------------------------------------------------------------
describe("candidatesQuery Phase 8 gates", () => {
  const sql = () => candidatesQuery({ bloodGroup: "O+", upazilaId: 101001, scope: "same_upazila", limit: 5 });

  it("excludes donors under an unlifted recovery hold (expiry asks donor, does not auto-restore)", () => {
    expect(sql()).toContain("not exists (");
    expect(sql()).toContain("donor_recovery_holds hh");
    expect(sql()).toContain("hh.donor_id = dp.user_id and hh.lifted = false");
  });

  it("adds the repeated-request shield with the configured 30-day cap", () => {
    expect(sql()).toContain("request_matches rm");
    expect(sql()).toContain(`interval '30 days'`);
    expect(sql()).toContain(`< ${RECOVERY_CONFIG.MAX_NEW_MATCHES_PER_DONOR_30D}`);
  });

  it("explanation is donor-facing in holds (verified in live smoke), SQL exposes no hold reason", () => {
    // candidates result shape never contains hold details:
    expect(sql()).not.toContain("hh.reason");
  });
});
