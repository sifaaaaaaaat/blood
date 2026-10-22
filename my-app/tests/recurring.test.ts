import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db: chains are awaited, so each terminal consumption (maybeSingle,
// single, or the `then` of an awaited update/eq chain) is fed the next result
// from a FIFO queue. rrpcCalls/eqCalls record what the service touched.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  rpcResults: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  queue: [] as Array<{ data: unknown; error: { message: string } | null }>,
  eqCalls: [] as Array<{ col: string; val: string }>,
}));

vi.mock("@/src/lib/db", () => {
  const client = () => {
    const obj: Record<string, unknown> = {
      select: () => obj,
      insert: () => obj,
      upsert: () => obj,
      update: () => obj,
      delete: () => obj,
      eq: (col: string, val: unknown) => {
        state.eqCalls.push({ col, val: String(val) });
        return obj;
      },
      order: () => obj,
      limit: () => obj,
      from: () => obj,
      maybeSingle: () => Promise.resolve(state.queue.shift() ?? { data: null, error: null }),
      single: () => Promise.resolve(state.queue.shift() ?? { data: null, error: null }),
      then: (
        res?: (v: { data: unknown; error: { message: string } | null }) => unknown,
        rej?: (r: unknown) => unknown
      ) => Promise.resolve(state.queue.shift() ?? { data: null, error: null }).then(res, rej),
    };
    return {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        return Promise.resolve(state.rpcResults[fn] ?? { data: null, error: null });
      },
      from: () => obj,
    };
  };
  return {
    getServiceRoleClient: client,
    createUserClient: async () => client(),
    createAuthedClient: async () => client(),
  };
});

import {
  listSchedules, createSchedule, setScheduleActive, deleteSchedule, materializeDraft,
} from "@/src/lib/services/recurring";
import type { AuthUser } from "@/src/lib/auth";

const owner = { id: "11111111-1111-1111-1111-111111111111", isAdmin: false } as never as AuthUser;
const scheduleId = "22222222-2222-2222-2222-222222222222";
const requestId = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResults = {};
  state.eqCalls = [];
  state.queue = [];
});

// ---------------------------------------------------------------------------
// Consent is a literal at creation: no value other than true passes zod.
// ---------------------------------------------------------------------------
describe("createSchedule", () => {
  it("rejects a missing consent literal before any DB call", async () => {
    const res = await createSchedule(owner, {
      blood_group: "O+",
      hospital_name: "DMCH",
      location: { upazila_id: 101001 },
      units_needed: 2,
      interval_days: 14,
      consent_confirmed: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
    expect(state.eqCalls).toHaveLength(0);
  });

  it("rejects an out-of-range interval before any DB call", async () => {
    const res = await createSchedule(owner, {
      blood_group: "O+",
      hospital_name: "DMCH",
      location: { upazila_id: 1 },
      units_needed: 2,
      interval_days: 900,
      consent_confirmed: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe("interval_days");
    expect(state.eqCalls).toHaveLength(0);
  });

  it("insert returns no row (RLS rejected) → refused, nothing faked", async () => {
    state.queue = [{ data: [], error: null }];
    const res = await createSchedule(owner, {
      blood_group: "O+",
      hospital_name: "DMCH",
      location: { upazila_id: 1 },
      units_needed: 2,
      interval_days: 14,
      consent_confirmed: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("db_error");
  });
});

// ---------------------------------------------------------------------------
// Per-schedule scoping: pause/resume/delete ALWAYS filter by id AND owner.
// ---------------------------------------------------------------------------
describe("schedule ops stay per-schedule", () => {
  it("pause targets exactly (id, creator_id)", async () => {
    state.queue = [{ data: { id: scheduleId }, error: null }, { data: { id: scheduleId }, error: null }];
    const res = await setScheduleActive(owner, scheduleId, false);
    expect(res.ok).toBe(true);
    // Both statements (ownership-read + update) are filtered by BOTH id and
    // creator_id — a pause can never touch another schedule of the same owner.
    expect(state.eqCalls.filter((c) => c.col === "id").map((c) => c.val)).toEqual([
      scheduleId, scheduleId,
    ]);
    expect(state.eqCalls.filter((c) => c.col === "creator_id").map((c) => c.val)).toEqual([
      owner.id, owner.id,
    ]);
  });

  it("delete scrubs consent + label and deactivates (privacy-honest)", async () => {
    state.queue = [{ data: { id: scheduleId }, error: null }, { data: { id: scheduleId }, error: null }];
    const res = await deleteSchedule(owner, scheduleId);
    expect(res.ok).toBe(true);
    expect(state.eqCalls.filter((c) => c.col === "id").map((c) => c.val)).toEqual([
      scheduleId, scheduleId,
    ]);
  });

  it("missing schedule (RLS hides it) → not_found", async () => {
    const res = await setScheduleActive(owner, scheduleId, true);
    if (!res.ok) expect(res.code).toBe("not_found");
    expect(res.ok).toBe(false);
  });

  it("non-UUID ids are refused before any DB call", async () => {
    for (const fn of [
      () => setScheduleActive(owner, "../etc/passwd", true),
      () => deleteSchedule(owner, "x' or '1'='1"),
      () => materializeDraft(owner, "not-a-uuid"),
    ]) {
      const res = await fn();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("validation_error");
    }
    expect(state.eqCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// List: privacy-deleted rows (inactive AND consent-scrubbed) disappear.
// ---------------------------------------------------------------------------
describe("listSchedules filters deleted rows", () => {
  it("keeps the paused (consented) row, hides the deleted one", async () => {
    state.queue = [{
      data: [
        { id: "a", active: true, consent_confirmed: true, blood_group: "O+", units_needed: 2, interval_days: 10, patient_label: "", hospital_name: "H", location_id: 1, location_text: null, contact_pref: "in_app", next_due_at: new Date().toISOString(), last_request_id: null, last_materialized_at: null },
        { id: "b", active: false, consent_confirmed: true, blood_group: "B+", units_needed: 1, interval_days: 10, patient_label: "p", hospital_name: "H", location_id: 1, location_text: null, contact_pref: "in_app", next_due_at: new Date().toISOString(), last_request_id: null, last_materialized_at: null },
        { id: "c", active: false, consent_confirmed: false, blood_group: "A+", units_needed: 1, interval_days: 10, patient_label: "", hospital_name: "deleted", location_id: 1, location_text: null, contact_pref: "in_app", next_due_at: new Date().toISOString(), last_request_id: null, last_materialized_at: null },
      ],
      error: null,
    }];
    const res = await listSchedules(owner);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.map((s) => s.id).sort()).toEqual(["a", "b"]);
      expect(res.data.some((s) => s.id === "c")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Materialization: due-gated, consent-checked, produces a DRAFT via
// createRequest, advances next_due by exactly one interval.
// ---------------------------------------------------------------------------
describe("materializeDraft", () => {
  const due = new Date(Date.now() - 86_400_000).toISOString();
  const scheduleRow = {
    id: scheduleId, creator_id: owner.id, patient_label: "thal ward 6", blood_group: "O+",
    hospital_name: "DMCH", location_id: 1, location_text: "Dhaka",
    units_needed: 3, interval_days: 15, contact_pref: "in_app",
    consent_confirmed: true, active: true, next_due_at: due,
    last_request_id: null, last_materialized_at: null,
  };

  it("not due → nothing generated, no draft", async () => {
    state.queue = [{
      data: { ...scheduleRow, next_due_at: new Date(Date.now() + 86_400_000).toISOString() },
      error: null,
    }];
    const res = await materializeDraft(owner, scheduleId);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.due).toBe(false);
      expect(res.data.requestId).toBeNull();
    }
    expect(state.rpcCalls.some((c) => c.fn === "bump_abuse_counter")).toBe(false);
  });

  it("paused schedule is refused as invalid_state before any write", async () => {
    state.queue = [{ data: { ...scheduleRow, active: false }, error: null }];
    const res = await materializeDraft(owner, scheduleId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("invalid_state");
  });

  it("consent scrubbed on the row → forbidden (cannot materialize a deleted schedule)", async () => {
    state.queue = [{ data: { ...scheduleRow, consent_confirmed: false }, error: null }];
    const res = await materializeDraft(owner, scheduleId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("due schedule → draft created + next_due advanced by exactly interval_days", async () => {
    state.rpcResults.bump_abuse_counter = { data: [{ allowed: true, cnt: 1 }], error: null };
    // Consumption order: (1) schedule read, (2) createRequest upsert result,
    // (3) post-materialize update.
    state.queue = [
      { data: scheduleRow, error: null },
      { data: { id: requestId, status: "draft" }, error: null },
      { data: { id: scheduleId }, error: null },
    ];

    const res = await materializeDraft(owner, scheduleId);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.due).toBe(true);
      expect(res.data.requestId).toBe(requestId);
      const expected = new Date(Date.parse(due) + 15 * 86_400_000).toISOString();
      expect(res.data.nextDueAt).toBe(expected);
    }
    // Insert went through the request create path (abuse counter bumped).
    expect(state.rpcCalls.some((c) => c.fn === "bump_abuse_counter")).toBe(true);
    // Draft, not submitted: no draft→submitted transition was recorded.
    expect(state.rpcCalls.some((c) => c.fn === "record_transition")).toBe(false);
  });
});
