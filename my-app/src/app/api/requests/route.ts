import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { createRequest, listOwnRequests } from "@/src/lib/services/requests";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

export async function POST(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "request body must be JSON" }, { status: 400 });
  }
  const result = await createRequest(auth, body);
  if (!result.ok) {
    const status =
      result.code === "validation_error" ? 400 :
      result.code === "rate_limited" ? 429 : 500;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result, { status: (result as { existing?: boolean }).existing ? 200 : 201 });
}

export async function GET(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await listOwnRequests(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
