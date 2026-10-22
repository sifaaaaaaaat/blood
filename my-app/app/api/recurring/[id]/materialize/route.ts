import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { materializeDraft } from "@/src/lib/services/recurring";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Materialize a DUE schedule into the owner's DRAFT blood request.
 * Never sends anything: the owner reviews the draft and submits it through
 * the standard flow (same consent, caps and matching gates as every request).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const result = await materializeDraft(auth, id);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "not_found" ? 404 :
    result.code === "invalid_state" || result.code === "forbidden" ? 409 :
    result.code === "rate_limited" ? 429 : 500;
  return NextResponse.json(result, { status });
}
