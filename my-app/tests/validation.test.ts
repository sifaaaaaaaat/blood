import { describe, it, expect } from "vitest";
import {
  donorRegistrationSchema,
  donorUpdateSchema,
  normalizeBdMobile,
  publicDonorSearchItemSchema,
} from "@/src/lib/validation/donor";

const base = {
  display_name: "Rahim Ahmed",
  phone: "01811117777",
  blood_group: "O+" as const,
  birth_year: new Date().getUTCFullYear() - 25,
  location: { division_id: 1, district_id: 3, upazila_id: 22 },
  notify_consent: false,
};

describe("phone normalization", () => {
  it("normalizes local 01XXXXXXXXX to +880 E.164", () => {
    expect(normalizeBdMobile("01811117777")).toBe("+8801811117777");
  });
  it("normalizes 880-prefixed without plus", () => {
    expect(normalizeBdMobile("8801811117777")).toBe("+8801811117777");
  });
  it("normalizes full E.164 input", () => {
    expect(normalizeBdMobile("+8801811117777")).toBe("+8801811117777");
  });
  it("rejects invalid operator prefixes (landline-looking)", () => {
    expect(donorRegistrationSchema.safeParse({ ...base, phone: "0211117777" }).success).toBe(false);
  });
});

describe("donor registration validation", () => {
  it("accepts a complete valid payload", () => {
    expect(donorRegistrationSchema.safeParse(base).success).toBe(true);
  });
  it("rejects under-16 birth_year", () => {
    const y = new Date().getUTCFullYear() - 10;
    expect(donorRegistrationSchema.safeParse({ ...base, birth_year: y }).success).toBe(false);
  });
  it("rejects unknown/extra fields (strict schema)", () => {
    expect(
      donorRegistrationSchema.safeParse({ ...base, is_admin: true }).success
    ).toBe(false);
  });
  it("rejects invalid blood group text", () => {
    expect(donorRegistrationSchema.safeParse({ ...base, blood_group: "A++" }).success).toBe(false);
  });
  it("rejects future last_donation_date", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(donorRegistrationSchema.safeParse({ ...base, last_donation_date: future }).success).toBe(false);
  });
  it("rejects consent=true with channel=none (incoherent consent)", () => {
    expect(
      donorRegistrationSchema.safeParse({ ...base, notify_consent: true, notify_channel: "none" }).success
    ).toBe(false);
  });
  it("rejects sms channel without explicit consent", () => {
    expect(
      donorRegistrationSchema.safeParse({ ...base, notify_consent: false, notify_channel: "sms" }).success
    ).toBe(false);
  });
  it("accepts sms channel with explicit consent", () => {
    expect(
      donorRegistrationSchema.safeParse({ ...base, notify_consent: true, notify_channel: "sms" }).success
    ).toBe(true);
  });
  it("defaults availability to 'available'", () => {
    const r = donorRegistrationSchema.parse(base);
    expect(r.availability).toBe("available");
  });
});

describe("donor update validation", () => {
  it("allows partial updates (availability only)", () => {
    expect(donorUpdateSchema.safeParse({ availability: "paused" }).success).toBe(true);
  });
  it("rejects attempts to change user_id or is_admin (not in schema)", () => {
    expect(donorUpdateSchema.safeParse({ user_id: "e" }).success).toBe(false);
    expect(donorUpdateSchema.safeParse({ is_admin: true }).success).toBe(false);
  });
  it("rejects invalid new phone format on update", () => {
    expect(donorUpdateSchema.safeParse({ phone: "123" }).success).toBe(false);
  });
});

describe("restricted field exposure (search responses)", () => {
  it("public search schema omits phone, verified state, and consent internals", () => {
    const shape = Object.keys(publicDonorSearchItemSchema.shape);
    expect(shape).not.toContain("phone");
    expect(shape).not.toContain("phone_normalized");
    expect(shape).not.toContain("verified_at");
    expect(shape).not.toContain("is_phone_verified");
    expect(shape).not.toContain("notify_consent");
    expect(shape).not.toContain("last_donation_date");
  });
});
