import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { parseCookieHeader } from "@supabase/ssr";
import { updateBloodBankSchema } from "@/src/lib/validation/directory";
import { adminPublishBloodBank, adminUpdateBloodBank } from "@/src/lib/services/bloodbanks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesOf = (req: NextRequest) => async () =>
  parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));

/**
 * PATCH /api/admin/blood-banks/:id — admin-only partial update and/or
 * publish toggle. The DB function re-verifies is_admin from the JWT.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  if (!auth.isAdmin) {
    return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "JSON body required" }, { status: 400 });
  }

  const { publish, ...fields } = body;
  if (typeof publish === "boolean") {
    const r = await adminPublishBloodBank(c, auth, id, publish);
    if (!r.ok) {
      const status = r.code === "rejected" && r.message.includes("not found") ? 404 : 500;
      return NextResponse.json(r, { status });
    }
    if (Object.keys(fields).length === 0) {
      return NextResponse.json(r, { status: 200 });
    }
  }

  const parsed = updateBloodBankSchema.safeParse(fields);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const r = await adminUpdateBloodBank(c, auth, id, parsed.data);
  return NextResponse.json(r, { status: r.ok ? 200 : r.code === "rejected" ? 404 : 500 });
}
