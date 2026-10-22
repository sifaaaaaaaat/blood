import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { listSchedules, createSchedule } from "@/src/lib/services/recurring";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recurring (thalassemia) schedules — owner-scoped.
 * GET  → list the signed-in owner's schedules (paused ones included).
 * POST → create a schedule (consent literal required; RLS enforces owner).
 */
export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await listSchedules(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const result = await createSchedule(auth, body);
  const status =
    result.ok ? 201 :
    result.code === "validation_error" ? 400 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}
