/**
 * Phase 11E tests: requester-side match creation and listing guards.
 * The db module is mocked (no DB, no env) — assertions target the invariants
 * that matter: authorization before every read/write, service-role inserts
 * tagged as the matching engine, and strict ID validation on server SQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type DbOp = { table: string; op: string; row?: unknown; cols?: unknown; col?: string; val?: string; opts?: unknown };

const state = vi.hoisted(() => ({
  ops: [] as unknown[],
  // FIFO queues per RPC fn: matching issues several exec_matching_sql calls
  // (a district lookup, one tier query per scope, then a count).
  rpcQ: {} as Record<string, { data: unknown; error: { message: string } | null }[]>,
  rpcCalls: [] as { fn: string; args?: Record<string, unknown> }[],
  tableRow: {} as Record<string, unknown>,
}));

vi.mock("@/src/lib/db", () => {
  const from = (name: string) => ({
    select: () => {
      const chain = {} as {
        eq(c: string, v: unknown): typeof chain;
        maybeSingle(): Promise<{ data: unknown; error: null }>;
        order(c?: string, o?: unknown): { limit(n?: number): Promise<{ data: unknown; error: null }> };
        limit(n?: number): Promise<{ data: unknown; error: null }>;
      };
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: state.tableRow[name] ?? null, error: null });
      chain.order = () => ({ limit: () => Promise.resolve({ data: state.tableRow[name] ?? null, error: null }) });
      chain.limit = () => Promise.resolve({ data: state.tableRow[name] ?? null, error: null });
      return chain;
    },
    upsert: (row: unknown, opts?: Record<string, unknown>) => {
      state.ops.push({ table: name, op: "upsert", row, opts });
      return Promise.resolve({ error: null });
    },
    update: (cols: unknown) => ({
      eq: (col: string, val: string) => {
        state.ops.push({ table: name, op: "update", cols, col, val });
        return Promise.resolve({ error: null });
      },
    }),
    insert: (row: unknown) => {
      state.ops.push({ table: name, op: "insert", row });
      return Promise.resolve({ error: null });
    },
  });
  const client = () => ({
    from,
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      const q = state.rpcQ[fn] ?? [];
      const r = q.length > 0 ? (q.shift() as { data: unknown; error: { message: string } | null }) : { data: null, error: null };
      return Promise.resolve(r);
    },
  });
  return {
    createAuthedClient: async () => client(),
    createUserClient: async () => client(),
    getServiceRoleClient: client,
  };
});

import { listRequestTransitions } from "@/src/lib/services/requests";
import { createMatchesFromCandidates, listRequestMatches, listOwnMatches, candidatesQuery } from "@/src/lib/services/matching";

const auth = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Owner",
  isDonor: true,
  isRequester: true,
  isAdmin: false,
  isModerator: false,
};
const REQ = "9b2f7f5e-0a41-4c6b-8e6a-1234567890ab";

beforeEach(() => {
  state.ops = [];
  state.rpcQ = {};
  state.rpcCalls = [];
  state.tableRow = {};
});

describe("listRequestTransitions / listRequestMatches — ID validation before SQL", () => {
  it("rejects non-uuid request ids without touching the database", async () => {
    const t = await listRequestTransitions(auth, "not-a-uuid");
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.code).toBe("validation_error");
    const m = await listRequestMatches(auth, "'; drop table x; --");
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.code).toBe("validation_error");
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("refuses a request the caller does not own (forbidden for users, not_found for admins)", async () => {
    state.tableRow = { blood_requests: null };
    const t = await listRequestTransitions(auth, REQ);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.code).toBe("forbidden");
    const admin = { ...auth, id: "22222222-2222-4222-8222-222222222222", isAdmin: true };
    const m = await listRequestMatches(admin, REQ);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.code).toBe("not_found");
  });
});

describe("createMatchesFromCandidates", () => {
  it("inserts service-role matches tagged as the matching engine, idempotently", async () => {
    // findCandidates flow: ownership gate row, abuse counter, district lookup,
    // tier queries (2-5), then the pool-count query.
    state.tableRow.blood_requests = {
      id: REQ,
      creator_id: auth.id,
      blood_group: "O+",
      location_id: 101001,
      status: "searching",
    };
    state.rpcQ.bump_abuse_counter = [{ data: [{ allowed: true }], error: null }];
    state.rpcQ.exec_location_sql = [{ data: [{ district_id: 101 }], error: null }];
    state.rpcQ.exec_matching_sql = [
      { data: [], error: null }, // tier-1: no candidates
      { data: [{ donor_user_id: "d1", display_name: "R", blood_group: "O+", upazila_name: "X", district_name: "Y", availability: "available", tier: 2 }], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [{ n: 1 }], error: null }, // final pool count
    ];

    const res = await createMatchesFromCandidates(auth, REQ);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.created).toBe(1);
      expect(res.data.total).toBe(1);
    }
    const up = state.ops[0] as DbOp;
    expect(up.table).toBe("request_matches");
    expect((up.row as Record<string, unknown>).donor_id).toBe("d1");
    expect((up.row as Record<string, unknown>).created_by).toBe("matching_engine");
    expect(up.opts).toMatchObject({ ignoreDuplicates: true });
  });

  it("candidate SQL never exposes contact or location-precision columns", () => {
    const q = candidatesQuery({ bloodGroup: "O+", upazilaId: 101001, scope: "same_upazila", districtId: 101, limit: 10 });
    const lowered = q.toLowerCase();
    expect(lowered).not.toContain("phone");
    expect(lowered).not.toContain("lat");
    expect(lowered).not.toContain("address");
  });
});

describe("listOwnMatches — donor-safe response shape", () => {
  it("embeds only the request summary passed by the select (no contact columns)", async () => {
    state.tableRow.request_matches = [
      {
        id: "m1",
        status: "pending",
        expires_at: "2026-11-01T00:00:00Z",
        created_at: "2026-10-31T00:00:00Z",
        request: {
          id: REQ,
          blood_group: "O+",
          hospital_name: "DMCH",
          location_text: "ward 4",
          urgency: "urgent",
          units_needed: 2,
          required_by: "2026-11-02T00:00:00Z",
          status: "searching",
        },
      },
    ];
    // listOwnMatches passes through whatever the session client returns; the
    // invariant we test: the service never ADDS contact fields of its own.
    const res = await listOwnMatches(auth);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const first = res.data[0];
      expect(first.request?.blood_group).toBe("O+");
      expect(JSON.stringify(first)).not.toContain("phone");
    }
  });
});
