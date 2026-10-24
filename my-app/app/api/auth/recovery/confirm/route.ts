import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/recovery/confirm — set the new password.
 *
 * Requires the recovery session that /api/auth/callback established when the
 * one-time email link was opened (PKCE exchange sets the auth cookies). No
 * session => 401, the UI then offers requesting a fresh link.
 *
 * Supabase invalidates access tokens on password change, so any other device
 * that was signed in is logged out with this very session forced to re-sign.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";

  if (password.length < 8) {
    return NextResponse.json(
      { ok: false, code: "weak_password", message: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }
  if (password.length > 72) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "Password must be at most 72 characters" },
      { status: 400 }
    );
  }

  const supabase = await createAuthedClient();
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error || !data?.user) {
    const code = error?.code ?? "no_session";
    if (code === "no_session" || /session|auth/i.test(code)) {
      return NextResponse.json(
        { ok: false, code: "gql_unauthorized", message: "Your reset link has expired — request a new one." },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { ok: false, code, message: "Password update failed. Please try again." },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, data: { message: "Password updated" } });
}
