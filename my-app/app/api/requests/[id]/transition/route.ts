import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { transitionRequest } from "@/src/lib/services/requests";
import { requestStatusSchema } from "@/src/lib/validation/requests";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null || typeof body.to !== "string") {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "body.to required" }, { status: 400 });
  }
  const to = requestStatusSchema.safeParse(body.to);
  if (!to.success) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "invalid status value" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await transitionRequest(auth, id, to.data, typeof body.reason === "string" ? body.reason : undefined);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "invalid_transition" || result.code === "invalid_state" ? 409 :
    result.code === "forbidden" ? 403 :
    result.code === "not_found" ? 404 : 500;
  return NextResponse.json(result, { status });
}
