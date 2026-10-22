import { NextRequest, NextResponse } from "next/server";
import { previewAvailability } from "@/src/lib/services/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const;
const intId = (raw: string | null): number | undefined => {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * GET /api/matching/candidates-preview?blood_group=B+&division=<id>[&district=<id>]
 *
 * Public aggregate availability preview for the homepage console. Returns
 * counts ONLY (how many consented available donors of that group sit inside
 * the chosen division/district, how many published banks). No donor identity,
 * no contact fields, no coordinates. Cached briefly at the client.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const group = sp.get("blood_group");
  const divisionId = intId(sp.get("division"));
  const districtId = intId(sp.get("district"));

  if (!group || !(GROUPS as readonly string[]).includes(group)) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "blood_group must be one of A+ A- B+ B- O+ O- AB+ AB-" },
      { status: 400 }
    );
  }
  if (divisionId === undefined && districtId === undefined) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "division or district id required" },
      { status: 400 }
    );
  }

  const result = await previewAvailability({ bloodGroup: group, divisionId, districtId });
  if (!result) {
    return NextResponse.json(
      { ok: false, code: "db_error", message: "database unavailable — try again shortly" },
      { status: 503 }
    );
  }
  return NextResponse.json(
    { ok: true, data: result },
    { headers: { "cache-control": "private, max-age=30" } }
  );
}
