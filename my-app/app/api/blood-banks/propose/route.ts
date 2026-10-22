import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { parseCookieHeader } from "@supabase/ssr";
import { proposeBloodBankSchema } from "@/src/lib/validation/directory";
import { proposeBloodBank } from "@/src/lib/services/bloodbanks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesOf = (req: NextRequest) => async () =>
  parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));

/**
 * POST /api/blood-banks/propose — signed-in user proposes a blood bank for
 * the directory. Always stored UNPUBLISHED (pending review); only a platform
 * admin can publish it afterwards via the existing admin PATCH path. Rid goes
 * through user_propose_blood_bank: the DB re-verifies the session and rejects
 * any client-supplied slug/publish.
 */
export async function POST(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "JSON body required" }, { status: 400 });
  }
  const parsed = proposeBloodBankSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const result = await proposeBloodBank(c, auth, parsed.data);
  if (!result.ok) {
    const status =
      result.code === "rejected" || result.code === "db_error" ? 400 : 500;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result, { status: 201 });
}
