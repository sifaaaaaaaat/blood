import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { registerDonor } from "@/src/lib/services/donors";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cookieStr = req.headers.get("cookie") ?? "";
  const cookies = parseCookieHeader(cookieStr).map((c) => ({ name: c.name, value: c.value }));

  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "request body must be JSON" }, { status: 400 });
  }

  const result = await registerDonor(auth, body);
  if (!result.ok) {
    const status = result.code === "validation_error" ? 400 : 500;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result, { status: 201 });
}
