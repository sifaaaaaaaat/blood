import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Mock the db module: capture every RPC and table operation into `state`.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  // table -> row returned by .select(...).eq(...).maybeSingle()
  tableRow: {} as Record<string, unknown>,
  // captures of .eq filters used in selects/updates
  filters: [] as Array<{ table: string; col: string; val: string }>,
  inserts: [] as Array<{ table: string; row: unknown }>,
  insertError: null as { message: string } | null,
}));

vi.mock("@/src/lib/db", () => {
  const makeTable = (name: string) => {
    const row = state.tableRow[name] ?? null;
    const t: {
      select: () => unknown;
      eq: (col: string, val: string | number) => unknown;
      maybeSingle: () => Promise<{ data: unknown }>;
      insert: (rowToInsert: unknown) => Promise<{ error: { message: string } | null }>;
      update: (cols: unknown) => unknown;
      __updating?: boolean;
      __updateCols?: unknown;
    } = {
      select: () => t,
      eq: (col, val) => {
        state.filters.push({ table: name, col, val: String(val) });
        // after an update().eq(...) chain we must be awaitable
        if (t.__updating) return Promise.resolve({ error: null });
        return t;
      },
      maybeSingle: () => Promise.resolve({ data: row }),
      insert: (rowToInsert) => {
        state.inserts.push({ table: name, row: rowToInsert });
        return Promise.resolve({ error: state.insertError });
      },
      update: (cols) => {
        t.__updating = true;
        t.__updateCols = cols;
        return t;
      },
    };
    return t;
  };
  return {
    getServiceRoleClient: () => ({
      rpc: (fn: string, args?: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        return Promise.resolve(state.rpcResult);
      },
      from: (name: string) => makeTable(name),
    }),
    createUserClient: async () => ({
      rpc: (fn: string, args?: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        return Promise.resolve(state.rpcResult);
      },
      from: (name: string) => makeTable(name),
    }),
  };
});

import {
  createActionToken,
  redeemActionToken,
  donorAct,
  revealDonorContact,
  shouldStopOutreach,
} from "@/src/lib/services/acceptance";

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResult = { data: null as unknown, error: null as { message: string } | null };
  state.tableRow = {};
  state.filters = [];
  state.inserts = [];
  state.insertError = null;
});

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const auth = { id: "donor-1" } as never;

// ---------------------------------------------------------------------------
// Token creation
// ---------------------------------------------------------------------------
describe("createActionToken", () => {
  it("returns an opaque url-safe token and stores ONLY its sha-256 hash", async () => {
    const res = await createActionToken({ matchId: "m-1", action: "accept", donorId: "d-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // opaque: base64url, no personal data encodable in it
    expect(res.data.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.data.token).not.toContain("m-1");
    expect(res.data.token).not.toContain("d-1");
    // stored row contains hash only, never raw token
    expect(state.inserts).toHaveLength(1);
    const row = state.inserts[0].row as Record<string, string>;
    expect(row.token_hash).toBe(sha256(res.data.token));
    expect(JSON.stringify(row)).not.toContain(res.data.token);
    expect(state.inserts[0].table).toBe("match_action_tokens");
  });

  it("encodes expiry (30 min) in the stored row and the result", async () => {
    const before = Date.now();
    const res = await createActionToken({ matchId: "m-1", action: "accept", donorId: "d-1" });
    if (!res.ok) throw (res as unknown as Error);
    const row = state.inserts[0].row as Record<string, string>;
    const stored = new Date(row.expires_at).getTime();
    const reported = new Date(res.data.expiresAt).getTime();
    expect((stored - before) / 60000).toBeGreaterThan(28);
    expect((stored - before) / 60000).toBeLessThanOrEqual(31);
    expect(reported).toBe(stored);
  });

  it("surfaces insert failures as db_error", async () => {
    state.insertError = { message: "unique violation" };
    const res = await createActionToken({ matchId: "m-1", action: "accept", donorId: "d-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("db_error");
  });
});

// ---------------------------------------------------------------------------
// Token redemption: single-use + expiry + donor binding
// ---------------------------------------------------------------------------
describe("redeemActionToken", () => {
  const validRow = {
    token_hash: "h",
    match_id: "m-1",
    action: "accept",
    expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    used_at: null as string | null,
  };

  it("rejects unknown tokens as token_invalid (no db probe of existence)", async () => {
    const res = await redeemActionToken("unknown-token");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("token_invalid");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("rejects already-used tokens (single-use enforced)", async () => {
    state.tableRow.match_action_tokens = { ...validRow, used_at: new Date().toISOString() };
    const res = await redeemActionToken("t");
    if (!res.ok) expect(res.code).toBe("token_used");
    expect(res.ok).toBe(false);
    // must not even attempt the donor action
    expect(state.rpcCalls.filter((c) => c.fn === "donor_respond_match")).toHaveLength(0);
  });

  it("rejects expired tokens before any action runs", async () => {
    state.tableRow.match_action_tokens = { ...validRow, expires_at: new Date(Date.now() - 1000).toISOString() };
    const res = await redeemActionToken("t");
    if (!res.ok) expect(res.code).toBe("token_expired");
    expect(res.ok).toBe(false);
    expect(state.rpcCalls.filter((c) => c.fn === "donor_respond_match")).toHaveLength(0);
  });

  it("looks the token up ONLY by its hash", async () => {
    state.tableRow.match_action_tokens = null;
    await redeemActionToken("some-raw-token");
    expect(state.filters).toContainEqual({ table: "match_action_tokens", col: "token_hash", val: sha256("some-raw-token") });
  });

  it("performs the action for the donor bound to the match, and marks token used", async () => {
    state.tableRow.match_action_tokens = validRow;
    // caller does not know donor id: service takes it from the match row (server-side)
    state.tableRow.request_matches = { donor_id: "donor-7", request_id: "req-1" };

    await redeemActionToken("t");

    // token marked used BEFORE/alongside the action (exactly-once defense)
    expect(state.rpcCalls.filter((c) => c.fn === "donor_respond_match")).toHaveLength(1);
    const rpc = state.rpcCalls.find((c) => c.fn === "donor_respond_match");
    expect(rpc?.args).toEqual({
      p_match_id: "m-1",
      p_action: "accept",
      p_donor: "donor-7",
      p_source: "action_token",
    });
  });

  it("maps a rejected action to action_rejected", async () => {
    state.tableRow.match_action_tokens = validRow;
    state.tableRow.request_matches = { donor_id: "d", request_id: "r" };
    state.rpcResult = {
      data: [{ ok: false, new_status: "already responded", message: "already responded" }],
      error: null,
    };
    const res = await redeemActionToken("t");
    if (!res.ok) expect(res.code).toBe("action_rejected");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-app donor action: authorization mapping
// ---------------------------------------------------------------------------
describe("donorAct", () => {
  it("requires auth subject and passes it as p_donor to the server-side guard", async () => {
    state.rpcResult = { data: [{ ok: true, new_status: "accepted", message: null }], error: null };
    const res = await donorAct(auth, "m-1", "accept");
    expect(res.ok).toBe(true);
    const rpc = state.rpcCalls.find((c) => c.fn === "donor_respond_match");
    expect(rpc?.args?.p_donor).toBe("donor-1");
  });

  it("maps 'not your match' to forbidden (impersonation attempt)", async () => {
    state.rpcResult = { data: [{ ok: false, new_status: null, message: "not your match" }], error: null };
    const res = await donorAct(auth, "m-1", "accept");
    if (!res.ok) expect(res.code).toBe("forbidden");
    expect(res.ok).toBe(false);
  });

  it("maps db failures to db_error without leaking internals as success", async () => {
    state.rpcResult = { data: null, error: { message: "permission denied" } };
    const res = await donorAct(auth, "m-1", "decline");
    if (!res.ok) expect(res.code).toBe("db_error");
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contact reveal: state recheck + authorization on EVERY call
// ---------------------------------------------------------------------------
describe("revealDonorContact", () => {
  it("passes requester+donor+request to the DB recheck function", async () => {
    state.rpcResult = { data: "+8801700000000", error: null };
    const res = await revealDonorContact({ id: "requester-1" } as never, "req-1", "donor-1");
    expect(res.ok).toBe(true);
    const rpc = state.rpcCalls.find((c) => c.fn === "reveal_contact");
    expect(rpc?.args).toEqual({ p_request_id: "req-1", p_donor_id: "donor-1", p_requester: "requester-1" });
  });

  const cases: Array<[string, string]> = [
    ["only the request creator may reveal contact", "forbidden"],
    ["no such match", "not_found"],
    ["match not accepted", "invalid_state"],
    ["request is cancelled", "request_cancelled"],
    ["match expired", "match_expired"],
    ["phone not verified", "phone_unverified"],
  ];
  it.each(cases)('maps db guard "%s" to code %s', (msg, code) => {
    state.rpcResult = { data: null, error: { message: msg } };
    const res = revealDonorContact({ id: "requester-1" } as never, "req-1", "donor-1");
    return expect(res).resolves.toMatchObject({ ok: false, code });
  });
});

// ---------------------------------------------------------------------------
// Outreach governor
// ---------------------------------------------------------------------------
describe("shouldStopOutreach", () => {
  it("stops once accepted count reaches units needed", async () => {
    state.rpcResult = { data: 3, error: null };
    expect(await shouldStopOutreach("req-1", 3)).toBe(true);
  });
  it("continues below the threshold", async () => {
    state.rpcResult = { data: 2, error: null };
    expect(await shouldStopOutreach("req-1", 3)).toBe(false);
  });
  it("queries the accepted count server-side, not in app memory", async () => {
    state.rpcResult = { data: 0, error: null };
    await shouldStopOutreach("req-1", 3);
    expect(state.rpcCalls[0].fn).toBe("count_accepted_for_request");
  });
});
