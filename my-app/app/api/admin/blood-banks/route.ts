import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { parseCookieHeader } from "@supabase/ssr";
import { createBloodBankSchema } from "@/src/lib/validation/directory";
import { adminCreateBloodBank, adminListAllBanks } from "@/src/lib/services/bloodbanks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesOf = (req: NextRequest) => async () =>
  parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));

/**
 * Admin blood-bank management (Phase 11C, directory-only scope).
 *  · GET  — admin-only list including unpublished rows.
 *  · POST — admin-only create (must carry a provenance sourceNote). The DB
 *    re-verifies is_admin inside admin_create_blood_bank; these app-level
 *    checks are convenience refusals that give cleaner HTTP codes.
 */
export async function GET(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await adminListAllBanks(c, auth);
  return NextResponse.json(result, {
    status: result.ok ? 200 : result.code === "forbidden" ? 403 : 500,
  });
}

export async function POST(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  if (!auth.isAdmin) {
    return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "JSON body required" }, { status: 400 });
  }
  const parsed = createBloodBankSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "validation failed", issues: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }
  const result = await adminCreateBloodBank(c, auth, parsed.data);
  return NextResponse.json(result, {
    status: result.ok ? 201 : result.code === "forbidden" || result.code === "rejected" ? 403 : 500,
  });
}
