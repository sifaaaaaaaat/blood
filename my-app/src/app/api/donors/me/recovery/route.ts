import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { getRecoveryState, confirmAvailability } from "@/src/lib/services/donations";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await getRecoveryState(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "forbidden" ? 403 : 500 });
}

/** Donor-driven resume: POST + confirm module marks availability confirmed. */
export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "confirm_availability") {
    return NextResponse.json({ ok: false, code: "validation_error", message: "action must be confirm_availability" }, { status: 400 });
  }
  const result = await confirmAvailability(auth);
  const status =
    result.ok ? 200 :
    result.code === "hold_active" ? 409 : 500;
  return NextResponse.json(result, { status });
}
