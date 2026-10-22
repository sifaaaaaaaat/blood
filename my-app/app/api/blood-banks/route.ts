import { NextRequest, NextResponse } from "next/server";
import { bankFilterSchema } from "@/src/lib/validation/directory";
import { listPublishedBanks } from "@/src/lib/services/bloodbanks";

export const runtime = "nodejs";

/** GET /api/blood-banks — public, published rows only, filterable. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const parsed = bankFilterSchema.safeParse(Object.fromEntries(sp.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "invalid filter parameters" },
      { status: 400 }
    );
  }
  const result = await listPublishedBanks(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
