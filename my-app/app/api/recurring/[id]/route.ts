import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { setScheduleActive, deleteSchedule } from "@/src/lib/services/recurring";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One recurring schedule, owner-scoped:
 * PATCH  → { active: boolean } pause/resume (restarts the cycle from now).
 * DELETE → privacy-honest remove: deactivates and scrubs identifying fields.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { active?: unknown } | null;
  if (typeof body?.active !== "boolean") {
    return NextResponse.json({ ok: false, code: "validation_error", message: "active must be a boolean" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await setScheduleActive(auth, id, body.active);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "not_found" ? 404 : 500;
  return NextResponse.json(result, { status });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const result = await deleteSchedule(auth, id);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "not_found" ? 404 : 500;
  return NextResponse.json(result, { status });
}
