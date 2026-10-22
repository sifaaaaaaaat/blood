import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { listMyBanks, listBankStock } from "@/src/lib/services/orgstock";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/org/banks?bank=<id>[&stock=1] — Phase 11F: the signed-in account's
 * blood-bank memberships, optionally with that one bank's stock history.
 */
export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const bankId = req.nextUrl.searchParams.get("bank");
  if (bankId) {
    const stock = await listBankStock(auth, bankId);
    const status =
      stock.ok ? 200 :
      stock.code === "forbidden" ? 403 :
      stock.code === "validation_error" ? 400 : 500;
    return NextResponse.json(stock, { status });
  }
  const result = await listMyBanks(auth.id);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
