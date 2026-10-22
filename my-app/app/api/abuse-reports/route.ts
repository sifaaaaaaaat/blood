import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { createAbuseReport, listMyAbuseReports } from "@/src/lib/services/moderation";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesOf = (req: NextRequest) => async () =>
  parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));

export async function POST(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as
    | { targetType?: string; targetId?: string | null; category?: string; detail?: string }
    | null;
  if (!body?.targetType || !body?.category) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "targetType and category are required" },
      { status: 400 }
    );
  }
  const result = await createAbuseReport(c, auth, {
    targetType: body.targetType,
    targetId: body.targetId ?? null,
    category: body.category,
    detail: body.detail,
  });
  const status =
    result.ok ? 201 :
    result.code === "unauthorized" ? 401 :
    result.code === "validation_error" ? 400 :
    result.code === "rate_limited" ? 429 : 500;
  return NextResponse.json(result, { status });
}

export async function GET(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await listMyAbuseReports(c, auth);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
