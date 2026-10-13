import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { fanOutMatchesForRequest } from "@/src/lib/services/fanout";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fan out notifications for all pending matches of a request.
 * Requester (or an admin) only — same authorization rule as matching.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const result = await fanOutMatchesForRequest(auth, id);
  const status =
    result.ok ? 200 :
    result.code === "not_found" ? 404 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}
