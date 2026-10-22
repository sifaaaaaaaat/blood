import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { adminListCamps, adminUpsertCamp } from "@/src/lib/services/camps";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

/** GET — all camps (draft + published), admin only. */
export async function GET(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await adminListCamps(auth);
  const status = result.ok ? 200 : result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}

/** POST — create/update a camp (admin only; DB re-verifies the role). */
export async function POST(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "JSON body required" }, { status: 400 });
  }
  const result = await adminUpsertCamp(auth, body);
  const status =
    result.ok ? 201 :
    result.code === "validation_error" ? 400 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}
