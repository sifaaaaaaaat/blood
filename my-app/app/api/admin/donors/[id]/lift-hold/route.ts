import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { adminLiftHold } from "@/src/lib/services/donations";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { note?: string; medicalAuthorityName?: string } | null;
  const { id } = await ctx.params;
  const result = await adminLiftHold(auth, id, String(body?.note ?? ""), String(body?.medicalAuthorityName ?? ""));
  const status =
    result.ok ? 200 :
    result.code === "forbidden" ? 403 :
    result.code === "requirement_missing" ? 422 : // authorization gate failure
    result.code === "rejected" ? 409 : 500;
  return NextResponse.json(result, { status });
}
