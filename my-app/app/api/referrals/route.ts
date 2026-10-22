import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { myReferralSummary, redeemCode } from "@/src/lib/services/referrals";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Referral attribution (community-recognition ledger only):
 * GET  → the caller's own code + redemption count.
 * POST → { code } — redeem someone else's code (idempotent for the caller).
 * Never affects matching, scoring or eligibility anywhere.
 */
export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await myReferralSummary();
  const status = result.ok ? 200 : result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}

export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const result = await redeemCode(auth, body?.code);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "refused" ? 409 : 500;
  return NextResponse.json(result, { status });
}
