import { NextRequest, NextResponse } from "next/server";
import { listDistricts, listDivisions, listUpazilas } from "@/src/lib/services/locations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const intId = (raw: string | null): number | null => {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * GET /api/locations — public location lookups from the platform's own
 * seeded hierarchy (Phase 4), powering the donor registration and profile
 * forms' division → district → upazila cascades.
 *
 *   /api/locations                      → divisions
 *   /api/locations?division=<id>        → districts of that division
 *   /api/locations?district=<id>        → upazilas of that district
 *
 * An unknown/invalid hierarchy parent is a 400 validation error, not a
 * silent empty list.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const divisionRaw = sp.get("division");
  const districtRaw = sp.get("district");

  if (districtRaw) {
    const districtId = intId(districtRaw);
    if (districtId === null) {
      return NextResponse.json(
        { ok: false, code: "validation_error", message: "district must be a positive integer" },
        { status: 400 }
      );
    }
    const r = await listUpazilas(districtId);
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }

  if (!divisionRaw) {
    const r = await listDivisions();
    return NextResponse.json(r, { status: r.ok ? 200 : 500 });
  }
  const divisionId = intId(divisionRaw);
  if (divisionId === null) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "division must be a positive integer" },
      { status: 400 }
    );
  }
  const r = await listDistricts(divisionId);
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
