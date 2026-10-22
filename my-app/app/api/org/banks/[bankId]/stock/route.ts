import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { listBankStock, reportStock } from "@/src/lib/services/orgstock";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

/** GET — stock history for the member's bank. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ bankId: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { bankId } = await ctx.params;
  const result = await listBankStock(auth, bankId);
  const status =
    result.ok ? 200 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}

/**
 * POST — the bank itself reports inventory. The report is timestamped and
 * attributed to the reporting account; the directory shows stock only from
 * these legitimate, on-record updates.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ bankId: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "JSON body required" }, { status: 400 });
  }
  const { bankId } = await ctx.params;
  const result = await reportStock(auth, bankId, body);
  const status =
    result.ok ? 201 :
    result.code === "validation_error" ? 400 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}
