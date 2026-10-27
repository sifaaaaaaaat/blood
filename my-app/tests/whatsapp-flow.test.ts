import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db: a tiny table store + recorded RPC calls, mirroring the harness used
// by the other service tests (see notifications.test.ts).
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResults: {} as Record<string, unknown>,
  rpcErrors: {} as Record<string, { message: string }>,
  // table -> rows returned by an awaited select chain
  rows: {} as Record<string, unknown[]>,
  // table -> row returned by maybeSingle()
  single: {} as Record<string, unknown>,
  updates: [] as Array<{ table: string; cols: Record<string, unknown> }>,
  // last eq() value per table, so donor-scoped tables can filter for real
  lastEq: {} as Record<string, string>,
  // donor -> per-table rows (models the real donor_id filter)
  donorRows: {} as Record<string, Record<string, unknown[]>>,
}));

vi.mock("@/src/lib/db", () => {
  const makeTable = (name: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      eq: (col: string, val: unknown) => {
        state.lastEq[name] = String(val);
        return chain;
      },
      in: self,
      neq: self,
      order: self,
      limit: self,
      maybeSingle: () => Promise.resolve({ data: state.single[name] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        const scoped = state.donorRows[state.lastEq[name] ?? ""];
        const data = scoped?.[name] ?? state.rows[name] ?? [];
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    });
    return {
      select: () => chain,
      update: (cols: Record<string, unknown>) => {
        state.updates.push({ table: name, cols });
        return { eq: () => Promise.resolve({ error: null }) };
      },
    };
  };
  const client = () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({
        data: state.rpcResults[fn] ?? null,
        error: state.rpcErrors[fn] ?? null,
      });
    },
    from: (name: string) => makeTable(name),
  });
  return { getServiceRoleClient: client, createUserClient: async () => client() };
});

import {
  parseDonorChoice,
  composeMatchAsk,
  composeDonationGapQuestion,
  composeDonorInRestPeriod,
} from "@/src/lib/services/whatsapp-messages";
import { handleDonorWhatsAppReply, toE164 } from "@/src/lib/services/whatsapp-flow";

const DONOR_ID = "347c0366-eb43-4209-8452-8b18d5346884";
const MATCH_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "20cace2e-c607-4d11-bf94-ce55f8c4930b";
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

/** Baseline world: a known donor with one open conversation at `stage`. */
function stageWorld(stage: "awaiting_accept" | "awaiting_donation_gap", matchStatus: string) {
  state.single = {
    blood_requests: { status: "submitted", blood_group: "B+", units_needed: 2, location_text: "DMCH", urgency: "urgent", location_id: 101001 },
    upazilas: { name: "Dhanmondi", district_id: 101 },
    districts: { name: "Dhaka" },
  };
  state.rows = {
    contact_numbers: [{ user_id: DONOR_ID }],
    whatsapp_match_sessions: [{ match_id: MATCH_ID, stage, created_at: new Date().toISOString() }],
    request_matches: [{ id: MATCH_ID, request_id: REQUEST_ID, status: matchStatus, expires_at: FUTURE }],
  };
  state.rpcResults = {
    donor_respond_match: [{ ok: true, new_status: matchStatus, message: null }],
    whatsapp_declare_recent_donation: [{ ok: true, message: "paused", paused_until: "2027-01-27" }],
    whatsapp_release_match_after_ineligible: [{ ok: true, new_status: "unavailable", message: null }],
  };
}

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
  state.rpcErrors = {};
  state.rows = {};
  state.single = {};
  state.updates = [];
  state.lastEq = {};
  state.donorRows = {};
});

describe("donor reply parsing (both questions share 1 = first option, 2 = second)", () => {
  it("accepts digits, English words and Bangla words", () => {
    for (const t of ["1", " 1 ", "Accept", "accept", "YES", "ok", "হ্যাঁ", "১"]) {
      // Bangla digit ১ is normalized by NFKC to "1"
      expect(parseDonorChoice(t)).toBe("one");
    }
    for (const t of ["2", "no", "No", "ignore", "decline", "না"]) {
      expect(parseDonorChoice(t)).toBe("two");
    }
  });
  it("tolerates punctuation and emoji around the answer", () => {
    expect(parseDonorChoice("✅ Accept")).toBe("one");
    expect(parseDonorChoice("1. yes please")).toBe("one");
    expect(parseDonorChoice("no!")).toBe("two");
  });
  it("never guesses on free text", () => {
    for (const t of ["", "   ", "maybe later after work", "who is this?"]) {
      expect(parseDonorChoice(t)).toBeNull();
    }
  });
  it("normalizes sender numbers to E.164 digits only", () => {
    expect(toE164("8801758121651")).toBe("+8801758121651");
    expect(toE164("+880 1758-121651")).toBe("+8801758121651");
    expect(toE164("12345")).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});

describe("message templates (reference designs)", () => {
  const ctx = {
    bloodGroup: "B+",
    unitsNeeded: 2,
    locationText: "Dhaka Medical College Hospital",
    upazilaName: "Dhanmondi",
    districtName: "Dhaka",
    urgency: "urgent",
  };

  it("renders the request card with group, units, place, urgency and the ask", () => {
    const msg = composeMatchAsk(ctx);
    expect(msg).toContain("🩸 *Blood request near you*");
    expect(msg).toContain("Blood group needed: *B+*");
    expect(msg).toContain("Units required: 2");
    expect(msg).toContain("Dhaka Medical College Hospital");
    expect(msg).toContain("Dhanmondi, Dhaka");
    expect(msg).toContain("Urgent");
    expect(msg).toContain("Can you help?");
    expect(msg).toContain("Reply *1* to accept");
    expect(msg).toContain("Reply *2* to ignore");
  });

  it("asks the 3-month rest-period question after an accept", () => {
    const msg = composeDonationGapQuestion();
    expect(msg).toContain("Have you donated blood in the last 3 months?");
    expect(msg).toContain("Reply *1* for Yes");
    expect(msg).toContain("Reply *2* for No");
  });

  it("never claims medical eligibility, never leaks a phone number, stays within the bridge limit", () => {
    const msgs = [
      composeMatchAsk(ctx),
      composeDonationGapQuestion(),
      composeDonorInRestPeriod("2027-01-27"),
    ];
    for (const m of msgs) {
      expect(m.length).toBeLessThan(2000);
      expect(m.toLowerCase()).not.toContain("eligible");
      expect(m.toLowerCase()).not.toContain("medically fit");
      expect(m).not.toMatch(/\+?8801\d{9}/);
    }
  });

  it("tells the donor the cooldown date without giving medical advice", () => {
    const msg = composeDonorInRestPeriod("2027-01-27");
    expect(msg).toContain("2027-01-27");
    expect(msg).toContain("cannot donate again for three months");
  });
});

describe("inbound state machine", () => {
  it("accept → records the accept with source whatsapp and asks the 3-month question", async () => {
    stageWorld("awaiting_accept", "pending");
    const res = await handleDonorWhatsAppReply("8801758121651", "1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.handled).toBe(true);
    expect(res.data.replies[0]).toContain("Have you donated blood in the last 3 months?");

    const accept = state.rpcCalls.find((c) => c.fn === "donor_respond_match");
    expect(accept?.args).toMatchObject({ p_action: "accept", p_donor: DONOR_ID, p_source: "whatsapp" });
    const staged = state.updates.find((u) => u.table === "whatsapp_match_sessions");
    expect(staged?.cols.stage).toBe("awaiting_donation_gap");
  });

  it("ignore at the ask → declines and closes the conversation", async () => {
    stageWorld("awaiting_accept", "pending");
    const res = await handleDonorWhatsAppReply("8801758121651", "2");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.replies[0]).toContain("will not share your number");

    const decline = state.rpcCalls.find((c) => c.fn === "donor_respond_match");
    expect(decline?.args).toMatchObject({ p_action: "decline", p_source: "whatsapp" });
    expect(state.updates.find((u) => u.table === "whatsapp_match_sessions")?.cols.stage).toBe("done");
  });

  it("'no' to the 3-month question → donor stays accepted and is told the contact will be shared", async () => {
    stageWorld("awaiting_donation_gap", "accepted");
    const res = await handleDonorWhatsAppReply("8801758121651", "2");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.replies[0]).toContain("you are confirmed");
    expect(res.data.replies[0]).toContain("B+");
    // No release, no cooldown: the acceptance stands.
    expect(state.rpcCalls.some((c) => c.fn === "whatsapp_release_match_after_ineligible")).toBe(false);
    expect(state.rpcCalls.some((c) => c.fn === "whatsapp_declare_recent_donation")).toBe(false);
  });

  it("'yes' to the 3-month question → records the donation, releases the match, gives the date", async () => {
    stageWorld("awaiting_donation_gap", "accepted");
    const res = await handleDonorWhatsAppReply("8801758121651", "1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.replies[0]).toContain("2027-01-27");
    expect(res.data.replies[0]).toContain("will *not* share your number");

    expect(state.rpcCalls.map((c) => c.fn)).toContain("whatsapp_declare_recent_donation");
    const release = state.rpcCalls.find((c) => c.fn === "whatsapp_release_match_after_ineligible");
    expect(release?.args).toMatchObject({ p_match_id: MATCH_ID, p_donor: DONOR_ID });
  });

  it("an unknown number gets silence — nothing is disclosed", async () => {
    state.rows.contact_numbers = [];
    const res = await handleDonorWhatsAppReply("8801999999999", "1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.handled).toBe(false);
    expect(res.data.replies).toEqual([]);
    expect(state.rpcCalls).toEqual([]);
  });

  it("unrecognized text re-asks instead of acting", async () => {
    stageWorld("awaiting_accept", "pending");
    const res = await handleDonorWhatsAppReply("8801758121651", "who is this?");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.replies[0]).toContain("reply *1* or *2*");
    expect(state.rpcCalls).toEqual([]);
  });

  it("a closed request stops the conversation and never acts", async () => {
    stageWorld("awaiting_accept", "pending");
    state.single.blood_requests = { status: "cancelled" };
    const res = await handleDonorWhatsAppReply("8801758121651", "1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.replies[0]).toContain("not open for a reply any more");
    expect(state.rpcCalls).toEqual([]);
  });

  it("rejects an unusable sender number", async () => {
    const res = await handleDonorWhatsAppReply("abc", "1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("validation_error");
  });

  it("a number shared by several accounts answers for the one with the open conversation", async () => {
    stageWorld("awaiting_accept", "pending");
    const otherAccount = "99999999-9999-4999-8999-999999999999";
    // The shared phone resolves to an unrelated account first; only the second
    // owns the live match.
    state.rows.contact_numbers = [{ user_id: otherAccount }, { user_id: DONOR_ID }];
    state.donorRows = {
      [otherAccount]: { whatsapp_match_sessions: [], request_matches: [] },
    };
    const res = await handleDonorWhatsAppReply("8801758121651", "1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.donorId).toBe(DONOR_ID);
    expect(res.data.replies[0]).toContain("Have you donated blood in the last 3 months?");
    expect(state.rpcCalls.find((c) => c.fn === "donor_respond_match")?.args).toMatchObject({ p_donor: DONOR_ID });
  });

  it("a cancelled request never yields a reply even when the session exists", async () => {
    stageWorld("awaiting_donation_gap", "accepted");
    state.rows.request_matches = [{ id: MATCH_ID, request_id: REQUEST_ID, status: "cancelled_with_request", expires_at: FUTURE }];
    const res = await handleDonorWhatsAppReply("8801758121651", "2");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No live match for this stage → acknowledgement only, nothing acted on.
    expect(res.data.replies[0]).toContain("not open for a reply any more");
    expect(state.rpcCalls).toEqual([]);
  });
});
