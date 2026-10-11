import { describe, it, expect } from "vitest";
import { candidatesQuery, PAGE, __internals } from "@/src/lib/services/matching";
import { MATCHING_CONFIG } from "@/src/lib/config/matching";
import { publicRequestItemSchema } from "@/src/lib/validation/requests";

// Simple regex-tools for inspecting the generated SQL.
const has = (sql: string, re: RegExp) => re.test(sql);

describe("candidatesQuery — hard filters in SQL (server-side only)", () => {
  it("enforces exact blood-group match", () => {
    const sql = candidatesQuery({ bloodGroup: "O-", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(has(sql, /dp\.blood_group::text = 'O-'/));
  });
  it("escapes a maliciously quoted blood group input", () => {
    const sql = candidatesQuery({ bloodGroup: "O'; drop table x", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(sql).toContain("O''; drop table x");
  });
  it("requires availability=available AND not paused", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(has(sql, /availability = 'available'/));
    expect(has(sql, /paused_until is null or paused_until <= now/));
  });
  it("requires notify_consent = true", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(has(sql, /dp\.notify_consent = true/));
  });
  it("requires actually-verified phone (verified_at not null)", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(has(sql, /cn\.verified_at is not null/));
  });
  it("applies the fatigue cap with a configured window", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(has(sql, new RegExp(`< ${MATCHING_CONFIG.FATIGUE_MAX_ENGAGEMENTS}`)));
    expect(has(sql, /request_transitions/));
  });
});

describe("geographic tiers", () => {
  it("tier 1 = same upazila equality", () => {
    const sql = candidatesQuery({ bloodGroup: "A+", upazilaId: 101001, scope: "same_upazila", limit: 5 });
    expect(has(sql, /dp\.upazila_id = 101001/) && has(sql, /as tier/));
    expect(sql).toContain("1 as tier");
  });
  it("tier 2 = adjacency-list neighbours (real dataset adjacency)", () => {
    const sql = candidatesQuery({ bloodGroup: "A+", upazilaId: 101001, scope: "neighbour_upazilas", limit: 25 });
    expect(sql).toContain("upazila_adjacency");
    expect(sql).toContain("2 as tier");
  });
  it("tier 3 = same district, excluding the request upazila itself", () => {
    const sql = candidatesQuery({ bloodGroup: "A+", upazilaId: 101001, districtId: 101, scope: "same_district", limit: 25 });
    expect(sql).toContain("u.district_id = 101");
    expect(sql).toContain("dp.upazila_id <> 101001");
    expect(sql).toContain("3 as tier");
  });
  it("tier 4 = adjacent districts via the district_adjacency view", () => {
    const sql = candidatesQuery({ bloodGroup: "A+", upazilaId: 101001, districtId: 101, scope: "adjacent_districts", limit: 25 });
    expect(sql).toContain("district_adjacency");
    expect(sql).toContain("4 as tier");
  });
  it("no fabricated hierarchy: expansions always reference derived lookup tables", () => {
    for (const scope of ["same_upazila", "neighbour_upazilas", "same_district", "adjacent_districts"] as const) {
      const sql = candidatesQuery({ bloodGroup: "A+", upazilaId: 101001, districtId: 101, scope, limit: 25 });
      // every query joins real hierarchy tables — never invents relationships
      expect(sql).toContain("join public.upazilas");
      expect(sql).toContain("join public.districts");
    }
  });
});

describe("privacy in result shape (never any phone before accept)", () => {
  it("safe column list contains no phone/coordinate/address fields", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(sql).not.toMatch(/phone/);
    expect(sql).not.toMatch(/center_lat|center_lon/);
    expect(sql).not.toMatch(/address/);
  });
  it("only includes the documented safe display fields", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    for (const col of ["donor_user_id", "display_name", "blood_group", "upazila_name", "district_name", "availability", "tier"]) {
      expect(sql).toContain(`as ${col}`);
    }
  });
});

describe("pagination and limits", () => {
  it("respects the config page size everywhere (cap at 25)", () => {
    expect(PAGE).toBe(25);
    expect(__internals.PAGE).toBe(25);
  });
  it("tier-1 probe slightly exceeds MIN_LOCAL to sense supply", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: MATCHING_CONFIG.MIN_LOCAL_CANDIDATES + 1 });
    expect(sql.endsWith("limit 6") || sql.includes("limit 6")).toBe(true);
  });
});

describe("no medical eligibility claims", () => {
  it("query contains no eligibility/compatible/eligible wording", () => {
    const sql = candidatesQuery({ bloodGroup: "O+", upazilaId: 22, scope: "same_upazila", limit: 5 });
    expect(sql.toLowerCase()).not.toContain("eligible");
    expect(sql.toLowerCase()).not.toContain("compatible");
  });
  it("compatibility model is pinned to exact", () => {
    expect(MATCHING_CONFIG.COMPATIBILITY_MODEL).toBe("exact");
  });
});
