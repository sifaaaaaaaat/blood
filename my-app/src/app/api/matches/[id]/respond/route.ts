import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { donorAct } from "@/src/lib/services/acceptance";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_SCHEMA = new Set(["accept", "decline", "unavailable"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const action = (body as { action?: string } | null)?.action;
  if (typeof action !== "string" || !ACTION_SCHEMA.has(action)) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "action must be accept|decline|unavailable" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await donorAct(auth, id, action as "accept" | "decline" | "unavailable");
  const status =
    result.ok ? 200 :
    result.code === "forbidden" ? 403 :
    result.code === "action_rejected" ? 409 : 500;
  return NextResponse.json(result, { status });
}
