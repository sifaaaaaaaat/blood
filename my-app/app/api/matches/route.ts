import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { listOwnMatches } from "@/src/lib/services/matching";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/matches — Phase 11E: the signed-in donor's own matches with the
 * request summary. RLS scopes rows to the donor; the request summary embeds
 * only safe, already-published fields. Powers the in-app notification page.
 */
export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await listOwnMatches(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
