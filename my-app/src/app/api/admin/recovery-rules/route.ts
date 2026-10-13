import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { adminSetRecoveryRule } from "@/src/lib/services/donations";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as
    | { donationType?: string; days?: number; approvedByName?: string; approvalReference?: string }
    | null;
  if (!body?.donationType || typeof body.days !== "number" || !body.approvedByName || !body.approvalReference) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "donationType, days, approvedByName and approvalReference are required" },
      { status: 400 }
    );
  }
  const result = await adminSetRecoveryRule(auth, {
    donationType: String(body.donationType),
    days: Math.floor(body.days),
    approvedByName: String(body.approvedByName),
    approvalReference: String(body.approvalReference),
  });
  const status =
    result.ok ? 200 :
    result.code === "forbidden" ? 403 :
    result.code === "validation_error" ? 400 : 500;
  return NextResponse.json(result, { status });
}
