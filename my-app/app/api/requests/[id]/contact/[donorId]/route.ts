import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { revealDonorContact } from "@/src/lib/services/acceptance";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; donorId: string }> }) {
  const cookies = parseCookieHeader(_req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id, donorId } = await ctx.params;
  const result = await revealDonorContact(auth, id, donorId);
  const status =
    result.ok ? 200 :
    result.code === "forbidden" ? 403 :
    result.code === "not_found" ? 404 :
    result.code === "invalid_state" || result.code === "request_cancelled" || result.code === "match_expired" || result.code === "phone_unverified" ? 409 : 500;
  return NextResponse.json(result, { status });
}
