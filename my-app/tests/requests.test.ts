import { describe, it, expect } from "vitest";
import {
  bloodRequestCreateSchema,
  bloodRequestUpdateSchema,
  ALLOWED_TRANSITIONS,
  requestStatusSchema,
} from "@/src/lib/validation/requests";
import { isTerminal, checkCreateRate } from "@/src/lib/services/requests";

const future = (min = 60) => new Date(Date.now() + min * 60_000).toISOString();

const base = {
  blood_group: "O+" as const,
  hospital_name: "Square Hospital Ltd",
  location: { upazila_id: 22 },
  location_text: "Level 4, Inpatient Dept",
  urgency: "urgent" as const,
  units_needed: 2,
  required_by: future(120),
  consent_confirmed: true as const,
  contact_pref: "in_app" as const,
  idempotency_key: "retry-abc-123",
};

describe("request create validation", () => {
  it("accepts a complete valid submission", () => {
    expect(bloodRequestCreateSchema.safeParse(base).success).toBe(true);
  });
  it("rejects unknown fields (no patient name / NID / medical history)", () => {
    expect(bloodRequestCreateSchema.safeParse({ ...base, patient_name: "X" }).success).toBe(false);
    expect(bloodRequestCreateSchema.safeParse({ ...base, national_id: "123" }).success).toBe(false);
    expect(bloodRequestCreateSchema.safeParse({ ...base, medical_history: "..." }).success).toBe(false);
  });
  it("rejects missing/false consent confirmation", () => {
    const { consent_confirmed, ...noConsent } = base;
    expect(bloodRequestCreateSchema.safeParse(noConsent).success).toBe(false);
    expect(bloodRequestCreateSchema.safeParse({ ...base, consent_confirmed: false }).success).toBe(false);
  });
  it("rejects required_by in the past", () => {
    expect(bloodRequestCreateSchema.safeParse({ ...base, required_by: new Date(Date.now() - 60_000).toISOString() }).success).toBe(false);
  });
  it("rejects units outside 1..20", () => {
    expect(bloodRequestCreateSchema.safeParse({ ...base, units_needed: 0 }).success).toBe(false);
    expect(bloodRequestCreateSchema.safeParse({ ...base, units_needed: 21 }).success).toBe(false);
  });
  it("rejects short idempotency keys (dedupe is required by design)", () => {
    expect(bloodRequestCreateSchema.safeParse({ ...base, idempotency_key: "short" }).success).toBe(false);
  });
});

describe("request update validation", () => {
  it("allows partial field updates", () => {
    expect(bloodRequestUpdateSchema.safeParse({ units_needed: 3 }).success).toBe(true);
  });
  it("rejects attempts to change creator_id or status directly", () => {
    expect(bloodRequestUpdateSchema.safeParse({ creator_id: "x" }).success).toBe(false);
    expect(bloodRequestUpdateSchema.safeParse({ status: "fulfilled" }).success).toBe(false);
  });
});

describe("state machine", () => {
  it("permits legitimate forward transitions only", () => {
    expect(ALLOWED_TRANSITIONS.draft).toContain("submitted");
    expect(ALLOWED_TRANSITIONS.submitted).toContain("searching");
    expect(ALLOWED_TRANSITIONS.awaiting_responses).toContain("connected");
    expect(ALLOWED_TRANSITIONS.connected).toContain("fulfilled");
  });
  it("never allows clients to jump to fulfilled from early states", () => {
    expect(ALLOWED_TRANSITIONS.draft).not.toContain("fulfilled");
    expect(ALLOWED_TRANSITIONS.submitted).not.toContain("fulfilled");
    expect(ALLOWED_TRANSITIONS.searching).not.toContain("fulfilled");
    expect(ALLOWED_TRANSITIONS.awaiting_responses).not.toContain("fulfilled");
  });
  it("terminal states have no outgoing edges (avoid absurd chains)", () => {
    for (const s of ["fulfilled", "cancelled", "expired", "flagged"] as const) {
      expect(ALLOWED_TRANSITIONS[s] ?? []).toEqual([]);
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal("submitted")).toBe(false);
  });
  it("supports cancelled/expired/flagged from active states", () => {
    for (const s of ["draft", "submitted", "searching", "awaiting_responses"] as const) {
      const outs = ALLOWED_TRANSITIONS[s] ?? [];
      if (s === "draft") {
        // drafts are removed or submitted; moderation can flag them
        expect(outs).toContain("submitted");
        expect(outs).toContain("cancelled");
      } else {
        expect(outs).toContain("cancelled");
        expect(outs).toContain("expired");
        expect(outs).toContain("flagged");
      }
    }
  });
  it("rejects unknown status strings", () => {
    expect(requestStatusSchema.safeParse("randomly_yeeted").success).toBe(false);
  });
});

describe("create rate limiting", () => {
  it("blocks after MAX_PER_WINDOW submissions for the same user", () => {
    const uid = "test-user-" + Math.random();
    expect(checkCreateRate(uid)).toBe(true);
    expect(checkCreateRate(uid)).toBe(true);
    expect(checkCreateRate(uid)).toBe(true);
    expect(checkCreateRate(uid)).toBe(true);
    expect(checkCreateRate(uid)).toBe(true);
    expect(checkCreateRate(uid)).toBe(false); // 6th within 10 min
  });
  it("other users are unaffected (per-user bucket)", () => {
    expect(checkCreateRate("another-user-xyz")).toBe(true);
  });
});

describe("contact-information privacy", () => {
  it("public request shape contains no requester phone / contact fields", async () => {
    const { publicRequestItemSchema } = await import("@/src/lib/validation/requests");
    const keys = Object.keys(publicRequestItemSchema.shape);
    expect(keys).not.toContain("phone");
    expect(keys).not.toContain("contact_phone");
    expect(keys).not.toContain("requester_phone");
    expect(keys).not.toContain("contact_pref");
    expect(keys).not.toContain("request_notes"); // free text may hide PII
  });
});
