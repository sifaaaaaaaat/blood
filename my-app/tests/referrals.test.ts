import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}));

vi.mock("@/src/lib/db", () => {
  const client = () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcResults[fn] ?? { data: null, error: null });
    },
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [], error: null }),
      }),
      insert: async () => ({ data: null, error: null }),
    }),
  });
  return {
    getServiceRoleClient: client,
    createUserClient: async () => client(),
    createAuthedClient: async () => client(),
  };
});

import { myReferralSummary, redeemCode } from "@/src/lib/services/referrals";
import type { AuthUser } from "@/src/lib/auth";

const owner = { id: "11111111-1111-1111-1111-111111111111", isAdmin: false } as never as AuthUser;
const OTHER = { id: "22222222-2222-2222-2222-222222222222", isAdmin: false } as never as AuthUser;

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
});

describe("referral summary", () => {
  it("issues the owner's code and counts redemptions (ledger is owner-readable)", async () => {
    state.rpcResults.referral_issue_code = { data: "ABCD1234", error: null };
    const res = await myReferralSummary();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.code).toBe("ABCD1234");
      expect(res.data.referralCount).toBe(0);
    }
  });

  it("no/invalid code from the function → refused, not faked", async () => {
    state.rpcResults.referral_issue_code = { data: null, error: null };
    const res = await myReferralSummary();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("db_error");
  });
});

describe("redeemCode", () => {
  it("rejects malformed codes before any DB call", async () => {
    for (const bad of ["x", "../own; drop", "", "A".repeat(40), 42]) {
      const res = await redeemCode(OTHER, bad as never);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("validation_error");
    }
    expect(state.rpcCalls.some((c) => c.fn === "referral_redeem")).toBe(false);
  });

  it("surfaces DB refusal reasons honestly (unknown code / own code)", async () => {
    state.rpcResults.referral_redeem = { data: { ok: false, reason: "own code cannot be redeemed" }, error: null };
    const res = await redeemCode(OTHER, "ABCD1234");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("refused");
  });

  it("idempotent replay → ok with redeemed:false (no duplicate use)", async () => {
    state.rpcResults.referral_redeem = {
      data: { ok: true, redeemed: false, referral_count: 3 },
      error: null,
    };
    const res = await redeemCode(OTHER, "ABCD1234");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.redeemed).toBe(false);
      expect(res.data.referralCount).toBe(3);
    }
  });

  it("first redemption → ok with redeemed:true; not-signed-in maps to unauthorized", async () => {
    state.rpcResults.referral_redeem = { data: { ok: true, redeemed: true, referral_count: 1 }, error: null };
    const ok = await redeemCode(OTHER, "ABCD1234");
    expect(ok.ok).toBe(true);
    state.rpcResults.referral_redeem = { data: null, error: { message: "not signed in" } };
    const unauth = await redeemCode(OTHER, "ABCD1234");
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) expect(unauth.code).toBe("unauthorized");
  });
});
