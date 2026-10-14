import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { requestAccountReview } from "@/src/lib/services/moderation";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-service appeal: a disabled account asks for its disable decision to
 * be reviewed by an admin. Idempotent; refused when there is nothing to
 * appeal (or a review was already requested).
 */
export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await requestAccountReview(() => Promise.resolve(cookies), auth);
  const status =
    result.ok ? 200 :
    result.code === "rejected" ? 409 : 500;
  return NextResponse.json(result, { status });
}
