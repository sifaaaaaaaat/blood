import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { getOwnDonorProfile, updateDonor } from "@/src/lib/services/donors";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

export async function GET(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await getOwnDonorProfile(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "not_found" ? 404 : 500 });
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "request body must be JSON" }, { status: 400 });
  }
  const result = await updateDonor(auth, body);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "validation_error" ? 400 : 500 });
}
