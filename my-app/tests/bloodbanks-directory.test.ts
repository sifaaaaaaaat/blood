import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db — captures the full query chain so we can assert that directory
// filtering REALLY happens server-side (same approach as the Phase 10 tests).
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  filterOps: [] as Array<{ op: string; col?: string; arg?: unknown }>,
  restored: { from: "", select: "" } as { from: string; select: string },
  limitCount: 0 as number,
  rows: [] as unknown[],
}));

vi.mock("@/src/lib/db", () => {
  type Chain = ReturnType<typeof mkChain>;
  const mkChain = () => {
    const chain = {
      eq: (col: string, v: string | number | boolean) => {
        state.filterOps.push({ op: "eq", col, arg: v });
        return chain as Chain;
      },
      ilike: (col: string, v: string) => {
        state.filterOps.push({ op: "ilike", col, arg: v });
        return chain as Chain;
      },
      contains: (col: string, v: unknown[]) => {
        state.filterOps.push({ op: "contains", col, arg: v });
        return chain as Chain;
      },
      or: (expr: string) => {
        state.filterOps.push({ op: "or", arg: expr });
        return chain as Chain;
      },
      order: () => chain as Chain,
      limit: (n: number) => {
        state.limitCount = n;
        return Promise.resolve({ data: state.rows, error: null });
      },
    };
    return chain;
  };

  const client = () => ({
    rpc: (fn: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve(state.rpcResults[fn] ?? { data: null, error: null });
    },
    from: (table: string) => ({
      select: (cols: string) => {
        state.restored = { from: table, select: cols };
        return mkChain();
      },
    }),
  });
  return { getServiceRoleClient: client, createUserClient: async () => client() };
});

import {
  listPublishedBanks,
  adminCreateBloodBank,
  adminUpdateBloodBank,
  adminPublishBloodBank,
  adminListAllBanks,
  proposeBloodBank,
} from "@/src/lib/services/bloodbanks";
import {
  createBloodBankSchema,
  updateBloodBankSchema,
  bankFilterSchema,
  proposeBloodBankSchema,
} from "@/src/lib/validation/directory";
import type { AuthUser } from "@/src/lib/auth";
import type { CreateBloodBankInput } from "@/src/lib/validation/directory";

const donor = { id: "11111111-1111-1111-1111-111111111111", isAdmin: false, isModerator: false } as never as AuthUser;
const admin = { id: "22222222-2222-2222-2222-222222222222", isAdmin: true, isModerator: false } as never as AuthUser;
const cookies = async () => [] as { name: string; value: string }[];

const validCreate: CreateBloodBankInput = createBloodBankSchema.parse({
  slug: "dhaka-central-bank",
  name: "Dhaka Central Blood Bank",
  divisionId: 1,
  districtId: 3,
  address: "123 Mirpur Road, Dhaka",
  sourceNote: "DGHS hospital list 2026-10",
  publish: false,
});

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
  state.filterOps = [];
  state.limitCount = 0;
  state.rows = [];
});

// ---------------------------------------------------------------------------
// Public listing: published rows only; real filters applied server-side.
// ---------------------------------------------------------------------------
describe("listPublishedBanks", () => {
  it("always pins is_published=true (never exposes drafts)", async () => {
    await listPublishedBanks(bankFilterSchema.parse({}));
    expect(state.restored.from).toBe("blood_banks");
    expect(state.filterOps[0]).toEqual({ op: "eq", col: "is_published", arg: true });
  });

  it("applies division/district/kind/group filters", async () => {
    await listPublishedBanks(
      bankFilterSchema.parse({ divisionId: 1, districtId: 3, kind: "ngo_org", group: "O-" })
    );
    const eqs = state.filterOps.filter((o) => o.op === "eq" && o.col !== "is_published");
    expect(eqs).toContainEqual({ op: "eq", col: "division_id", arg: 1 });
    expect(eqs).toContainEqual({ op: "eq", col: "district_id", arg: 3 });
    expect(eqs).toContainEqual({ op: "eq", col: "kind", arg: "ngo_org" });
    expect(state.filterOps).toContainEqual({ op: "contains", col: "groups_at_issue", arg: ["O-"] });
  });

  it("sanitises search before the PostgREST .or() expression", async () => {
    await listPublishedBanks(bankFilterSchema.parse({ q: "bad,OR(name.eq.x)%weird" }));
    const orOp = state.filterOps.find((o) => o.op === "or");
    expect(orOp).toBeDefined();
    const expr = String(orOp?.arg);
    // Exactly two clauses, template-only % delimiters, and NO filter-syntax
    // characters (%), commas, brackets) inside the embedded user text.
    expect(expr).toMatch(/^name\.ilike\.%[^%,()"]*%,name_bn\.ilike\.%[^%,()"]*%$/);
  });

  it("requests limit+offset rows and slices the offset (no client-side trust)", async () => {
    state.rows = Array.from({ length: 4 }, (_, i) => ({
      id: `u${i}`, slug: `s${i}`, name: `B${i}`, name_bn: null, kind: "hospital_bank",
      address: "X", source_note: "Y", groups_at_issue: [], phone_public: null,
      opening_hours: null, published_at: "2026-01-01",
      district_name: { id: 3, name: "Faridpur", bn_name: "ফরিদপুর", divisions: { id: 1, name: "Dhaka", bn_name: "ঢাকা" } },
      upazila_name: null,
    }));
    const res = await listPublishedBanks(bankFilterSchema.parse({ limit: 2, offset: 2 }));
    expect(state.limitCount).toBe(4);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Admin authorization: app-level refusal BEFORE any call; the DB re-verifies.
// ---------------------------------------------------------------------------
describe("admin authorization", () => {
  it("non-admin is refused to list/create/update/publish (no RPC is issued)", async () => {
    expect(await adminListAllBanks(cookies, donor)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await adminCreateBloodBank(cookies, donor, validCreate)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await adminUpdateBloodBank(cookies, donor, "x", { name: "New" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await adminPublishBloodBank(cookies, donor, "x", true)).toMatchObject({ ok: false, code: "forbidden" });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("admin create maps camelCase input onto the p_* RPC contract", async () => {
    state.rpcResults["admin_create_blood_bank"] = { data: [{ ok: true, message: "created", bank_id: "bank-1" }], error: null };
    const res = await adminCreateBloodBank(cookies, admin, validCreate);
    expect(res).toEqual({ ok: true, data: { id: "bank-1" } });
    expect(state.rpcCalls).toHaveLength(1);
    const args = state.rpcCalls[0].args as Record<string, unknown>;
    expect(state.rpcCalls[0].fn).toBe("admin_create_blood_bank");
    expect(args["p_slug"]).toBe("dhaka-central-bank");
    expect(args["p_division"]).toBe(1);
    expect(args["p_publish"]).toBe(false);
    expect(Array.isArray(args["p_groups"])).toBe(true);
  });

  it("admin create surfaces the DB refusal as a rejected result", async () => {
    state.rpcResults["admin_create_blood_bank"] = { data: [{ ok: false, message: "slug already exists" }], error: null };
    const res = await adminCreateBloodBank(cookies, admin, validCreate);
    expect(res).toMatchObject({ ok: false, code: "rejected", message: "slug already exists" });
  });

  it("admin publish routes through admin_publish_blood_bank", async () => {
    state.rpcResults["admin_publish_blood_bank"] = { data: [{ ok: true, message: "published" }], error: null };
    const res = await adminPublishBloodBank(cookies, admin, "u1", true);
    expect(res.ok).toBe(true);
    expect(state.rpcCalls[0].fn).toBe("admin_publish_blood_bank");
    expect(state.rpcCalls[0].args).toMatchObject({ p_id: "u1", p_publish: true });
  });
});

// ---------------------------------------------------------------------------
// User proposal: any signed-in user may propose; always unpublished; the DB
// re-verifies the session and rejects client-supplied slug/publish inputs.
// ---------------------------------------------------------------------------
describe("proposeBloodBank (user self-service)", () => {
  const proposal = {
    name: "Savar Community Bank",
    kind: "community_vault" as const,
    divisionId: 1,
    districtId: 3,
    address: "12 Station Road, Savar",
    sourceNote: "Visited the bank directly 2026-10",
  };

  it("signed-in non-admin can propose (session client RPC, no app-level refusal)", async () => {
    state.rpcResults["user_propose_blood_bank"] = {
      data: [{ ok: true, message: "proposed — pending review", bank_id: "bank-9" }],
      error: null,
    };
    const res = await proposeBloodBank(cookies, donor, proposal);
    expect(res).toEqual({ ok: true, data: { id: "bank-9" } });
    const args = state.rpcCalls[0].args as Record<string, unknown>;
    expect(state.rpcCalls[0].fn).toBe("user_propose_blood_bank");
    expect(args["p_name"]).toBe("Savar Community Bank");
    expect(args["p_upazila"]).toBeNull(); // service normalises missing upazila to NULL
  });

  it("surfaces the DB refusal (location mismatch etc.) as rejected", async () => {
    state.rpcResults["user_propose_blood_bank"] = {
      data: [{ ok: false, message: "district/upazila does not belong to the given division" }],
      error: null,
    };
    const res = await proposeBloodBank(cookies, donor, proposal);
    expect(res).toMatchObject({
      ok: false,
      code: "rejected",
      message: "district/upazila does not belong to the given division",
    });
  });

  it("proposal schema has NO slug and NO publish (never client-controlled)", () => {
    const sneaky = { ...proposal, slug: "sneaky-slug", publish: true } as Record<string, unknown>;
    const parsed = proposeBloodBankSchema.parse(sneaky);
    expect(JSON.stringify(parsed)).not.toContain("sneaky-slug");
    expect((parsed as unknown as { publish?: unknown }).publish).toBeUndefined();
    // Mandatory provenance still applies to user proposals.
    const noSource = { ...proposal } as Record<string, unknown>;
    delete noSource["sourceNote"];
    expect(proposeBloodBankSchema.safeParse(noSource).success).toBe(false);
    expect(proposeBloodBankSchema.safeParse({ ...proposal, address: "abc" }).success).toBe(false); // too short
    expect(proposeBloodBankSchema.parse(proposal).kind).toBe("community_vault");
  });
});

// ---------------------------------------------------------------------------
// Validation schema contract
// ---------------------------------------------------------------------------
describe("blood bank validation schemas", () => {
  it("refuses an invalid slug and a missing source note", () => {
    expect(createBloodBankSchema.safeParse({ ...validCreate, slug: "Bad Slug!" }).success).toBe(false);
    const withoutSource = { ...validCreate } as Record<string, unknown>;
    delete withoutSource["sourceNote"];
    expect(createBloodBankSchema.safeParse(withoutSource).success).toBe(false);
  });

  it("provides safe defaults (kind, publish=false) and dedupes groups", () => {
    const parsed = createBloodBankSchema.parse({
      slug: "x-bank", name: "X Bank", divisionId: 1, districtId: 3,
      address: "Somewhere 12", sourceNote: "Official list", groups: ["A+", "A+", "O-"],
    });
    expect(parsed.kind).toBe("hospital_bank");
    expect(parsed.publish).toBe(false);
    expect(parsed.groups).toEqual(["A+", "O-"]);
  });

  it("update schema stays partial and requires no fresh required fields", () => {
    expect(() => updateBloodBankSchema.parse({ name: "Renamed only" })).not.toThrow();
    expect(updateBloodBankSchema.parse({ publish: "true" })).toMatchObject({ publish: true });
  });

  it("filter schema rejects an unknown blood group", () => {
    expect(bankFilterSchema.safeParse({ group: "C+" }).success).toBe(false);
  });
});
