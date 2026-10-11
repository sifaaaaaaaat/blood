import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { findCandidates } from "@/src/lib/services/matching";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const requestId = req.nextUrl.searchParams.get("request_id");
  if (!requestId) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "request_id required" }, { status: 400 });
  }

  const result = await findCandidates(auth, requestId);
  const status =
    result.ok ? 200 :
    result.code === "not_found" ? 404 :
    result.code === "forbidden" ? 403 :
    result.code === "invalid_state" ? 409 : 500;
  return NextResponse.json(result, { status });
}
