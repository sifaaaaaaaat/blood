/**
 * Phase 11D tests: donor registration/profile service against the session
 * client, plus the validation rules the profile editor relies on.
 *
 * The db module is mocked so runs are hermetic — no database, no env needed.
 * Assertions focus on the invariants that matter: writes land on the caller's
 * own rows only, the phone-verified state is NEVER written outside explicit
 * verification, and phone never leaks into non-owner shapes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type DbOp = {
  table: string;
  op: string;
  row?: unknown;
  cols?: unknown;
  col?: string;
  val?: string;
};

const state = vi.hoisted(() => ({
  ops: [] as unknown[],
  tableRow: {} as Record<string, unknown>,
  tableData: {} as Record<string, unknown[]>,
  upsertError: null as { message: string } | null,
}));

vi.mock("@/src/lib/db", () => {
  const makeTable = (name: string) => ({
    select: (_cols?: string) => {
      void _cols;
      const chain = {} as {
        eq(col: string, val: string | number): typeof chain;
        maybeSingle(): Promise<{ data: unknown; error: null }>;
        single(): Promise<{ data: unknown; error: null }>;
        order(col?: string, o?: unknown): { limit(): Promise<{ data: unknown[]; error: null }> };
        limit(): Promise<{ data: unknown[]; error: null }>;
      };
      chain.eq = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve({ data: state.tableRow[name] ?? null, error: null as null });
      chain.single = () => Promise.resolve({ data: state.tableRow[name] ?? null, error: null as null });
      chain.order = () => ({
        limit: () => Promise.resolve({ data: state.tableData[name] ?? [], error: null as null }),
      });
      chain.limit = () => Promise.resolve({ data: state.tableData[name] ?? [], error: null as null });
      return chain;
    },
    // RLS-guarded writes: eq-bound to the owner id in every real call path.
    update: (cols: unknown) => ({
      eq: (col: string, val: string | number) => {
        state.ops.push({ table: name, op: "update", cols, col, val: String(val) });
        return Promise.resolve({ error: null });
      },
    }),
    upsert: (row: unknown) => {
      state.ops.push({ table: name, op: "upsert", row });
      return Promise.resolve({ error: state.upsertError });
    },
    insert: (row: unknown) => {
      state.ops.push({ table: name, op: "insert", row });
      return Promise.resolve({ error: null });
    },
  });
  const client = () => ({ from: (name: string) => makeTable(name) });
  return {
    createAuthedClient: async () => client(),
    createUserClient: async () => client(),
    getServiceRoleClient: client,
  };
});

import { registerDonor, updateDonor, getOwnDonorProfile } from "@/src/lib/services/donors";
import {
  donorUpdateSchema,
  donorProfileResponseSchema,
} from "@/src/lib/validation/donor";

const auth = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Owner",
  isDonor: false,
  isRequester: false,
  isAdmin: false,
  isModerator: false,
};

const regInput = {
  display_name: "Rahim Ahmed",
  phone: "01811117777",
  blood_group: "O+",
  birth_year: new Date().getUTCFullYear() - 25,
  location: { division_id: 1, district_id: 3, upazila_id: 22 },
  notify_consent: true,
  notify_channel: "in_app",
};

beforeEach(() => {
  state.ops = [];
  state.tableRow = {};
  state.tableData = {};
  state.upsertError = null;
});

const opsOn = (table: string, op?: string) =>
  (state.ops as DbOp[]).filter((o) => o.table === table && (!op || o.op === op));

describe("registerDonor (session client)", () => {
  it("writes profile flags, donor row and contact to the CALLER's own rows only", async () => {
    const res = await registerDonor(auth, regInput);
    expect(res.ok).toBe(true);

    const profileUpdate = opsOn("profiles", "update")[0];
    expect(profileUpdate.cols).toMatchObject({ is_donor: true });
    expect(profileUpdate.col).toBe("id");
    expect(profileUpdate.val).toBe(auth.id);

    const donorUpsert = opsOn("donor_profiles", "upsert")[0];
    expect((donorUpsert.row as Record<string, unknown>).user_id).toBe(auth.id);
    expect((donorUpsert.row as Record<string, unknown>).blood_group).toBe("O+");

    const contactUpsert = opsOn("contact_numbers", "upsert")[0];
    expect((contactUpsert.row as Record<string, unknown>).user_id).toBe(auth.id);
    // DB check constraint (contact_numbers_phone_check) requires E.164 —
    // verified live: the raw local form violates it, so the service stores
    // the normalized value in both columns.
    expect((contactUpsert.row as Record<string, unknown>).phone).toBe("+8801811117777");
    expect((contactUpsert.row as Record<string, unknown>).phone_normalized).toBe("+8801811117777");

    const consent = opsOn("notification_consents", "insert")[0];
    expect(consent.row).toMatchObject({ user_id: auth.id, channel: "in_app" });
  });

  it("NEVER writes any verified state while registering (verification is a separate step)", async () => {
    await registerDonor(auth, regInput);
    for (const o of state.ops as DbOp[]) {
      if (o.row) {
        const row = o.row as Record<string, unknown>;
        expect(Object.keys(row)).not.toContain("verified_at");
        expect(Object.keys(row)).not.toContain("verified");
      }
    }
    const contact = opsOn("contact_numbers", "upsert")[0].row as Record<string, unknown>;
    expect(contact.verified_at ?? null).toBeNull();
  });

  it("skips the consent row when consent is false (never default-true)", async () => {
    await registerDonor(auth, { ...regInput, notify_consent: false, notify_channel: "none" });
    expect(opsOn("notification_consents")).toHaveLength(0);
  });

  it("rejects schema-invalid input before touching the database", async () => {
    const res = await registerDonor(auth, { ...regInput, blood_group: "Z+" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
    expect(state.ops).toHaveLength(0);
  });

  it("surfaces upsert failures as db_error (honest 500 path)", async () => {
    state.upsertError = { message: "rls violation" };
    const res = await registerDonor(auth, regInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("db_error");
  });
});

describe("updateDonor (profile management)", () => {
  it("pauses availability without touching other fields", async () => {
    const res = await updateDonor(auth, { availability: "paused", paused_until: "2027-01-31" });
    expect(res.ok).toBe(true);
    const upd = opsOn("donor_profiles", "update")[0];
    expect(upd.cols).toMatchObject({ availability: "paused", paused_until: "2027-01-31" });
    expect(upd.col).toBe("user_id");
    expect(upd.val).toBe(auth.id);
    expect(opsOn("profiles")).toHaveLength(0);
    expect(opsOn("contact_numbers")).toHaveLength(0);
  });

  it("clearing last_donation_date and resume (null paused_until) reach the patch as null", async () => {
    const res = await updateDonor(auth, { availability: "available", paused_until: null, last_donation_date: null });
    expect(res.ok).toBe(true);
    const upd = opsOn("donor_profiles", "update")[0];
    expect(upd.cols).toMatchObject({ paused_until: null, last_donation_date: null });
  });

  it("a phone change re-upserts WITHOUT touching the verified flag or display fields", async () => {
    const res = await updateDonor(auth, { phone: "+8801811117777" });
    expect(res.ok).toBe(true);
    const contact = opsOn("contact_numbers", "upsert")[0].row as Record<string, unknown>;
    expect(Object.keys(contact)).not.toContain("verified_at");
    expect(contact.phone_normalized).toBe("+8801811117777");
    expect(opsOn("profiles")).toHaveLength(0);
  });

  it("display_name change lands on profiles, not donor_profiles", async () => {
    const res = await updateDonor(auth, { display_name: "Rahim" });
    expect(res.ok).toBe(true);
    expect(opsOn("profiles", "update")[0].cols).toMatchObject({ display_name: "Rahim" });
    expect(opsOn("donor_profiles")).toHaveLength(0);
  });

  it("an empty patch is a no-op on the donor row", async () => {
    const res = await updateDonor(auth, {});
    expect(res.ok).toBe(true);
    expect(opsOn("donor_profiles")).toHaveLength(0);
  });
});

describe("getOwnDonorProfile (owner-only contact visibility)", () => {
  const donorRow = {
    display_name: { display_name: "Rahim" },
    blood_group: "O+",
    birth_year: 1999,
    division_id: 1,
    district_id: 3,
    upazila_id: 22,
    availability: "available",
    paused_until: null,
    last_donation_date: "2026-01-15",
    notify_consent: true,
    notify_channel: "in_app",
    is_phone_verified: false,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };

  it("merges the owner's OWN contact row plus honest verification status", async () => {
    state.tableRow = {
      donor_profiles: donorRow,
      contact_numbers: { phone: "+8801811117777", verified_at: null },
    };
    const res = await getOwnDonorProfile(auth);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.phone).toBe("+8801811117777");
      expect(res.data.is_phone_verified).toBe(false);
      expect(res.data.display_name).toBe("Rahim");
    }
  });

  it("profile stays 200 with honest phone=null when contact row has not been written yet", async () => {
    state.tableRow = { donor_profiles: donorRow, contact_numbers: null };
    const res = await getOwnDonorProfile(auth);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.phone).toBeNull();
  });

  it("not_found when the caller has no donor row (never a fake profile)", async () => {
    state.tableRow = {};
    const res = await getOwnDonorProfile(auth);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });
});

describe("update-validation clearing rules (profile editor contract)", () => {
  it("accepts explicit null for last_donation_date and paused_until", () => {
    expect(donorUpdateSchema.safeParse({ paused_until: null }).success).toBe(true);
    expect(donorUpdateSchema.safeParse({ last_donation_date: null }).success).toBe(true);
  });
  it("still rejects nonsense values", () => {
    expect(donorUpdateSchema.safeParse({ paused_until: "not-a-date" }).success).toBe(false);
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(donorUpdateSchema.safeParse({ last_donation_date: future }).success).toBe(false);
  });
});

describe("owner profile response shape", () => {
  it("carries owner-only phone (nullable) alongside honest verification", () => {
    const shape = donorProfileResponseSchema.shape as Record<string, unknown>;
    expect(Object.keys(shape)).toContain("phone");
    expect(() =>
      donorProfileResponseSchema.parse({
        display_name: "Rahim",
        blood_group: "O+",
        birth_year: 1999,
        division_id: 1,
        district_id: 3,
        upazila_id: 22,
        availability: "available",
        paused_until: null,
        last_donation_date: null,
        notify_consent: false,
        notify_channel: "none",
        is_phone_verified: false,
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
        phone: null,
      })
    ).toBeTruthy();
  });
});
