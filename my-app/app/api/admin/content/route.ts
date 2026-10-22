import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { adminListContent, adminUpsertContent } from "@/src/lib/services/content";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

/** GET — all content items (draft + published), admin only. */
export async function GET(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await adminListContent(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "forbidden" ? 403 : 500 });
}

/** POST — create/update an article (admin only; DB re-verifies the role). */
export async function POST(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "JSON body required" }, { status: 400 });
  }
  const result = await adminUpsertContent(auth, body);
  const status =
    result.ok ? 201 :
    result.code === "validation_error" ? 400 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}
