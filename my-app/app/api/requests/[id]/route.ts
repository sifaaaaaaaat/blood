import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { getOwnRequest, updateOwnRequest } from "@/src/lib/services/requests";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const result = await getOwnRequest(auth, id);
  const status = result.ok ? 200 : result.code === "not_found" ? 404 : 500;
  return NextResponse.json(result, { status });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "request body must be JSON" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await updateOwnRequest(auth, id, body);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "invalid_state" || result.code === "not_found" ? 404 : 500;
  return NextResponse.json(result, { status });
}
