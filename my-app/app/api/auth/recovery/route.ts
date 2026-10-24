import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/recovery — request a password-reset email.
 *
 * Anti-enumeration by design: every syntactically valid email gets the same
 * success response whether or not an account exists (the account-existence
 * signal lives only in the user's inbox). Delivery failures surface as a
 * generic delivery error — never as "user not found".
 *
 * The email's one-time link redirects through the existing PKCE exchange at
 * /api/auth/callback (same-origin `next` validation included): the user lands
 * on /reset with a recovery session already established, then POSTs the new
 * password to /api/auth/recovery/confirm.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "A valid email address is required" },
      { status: 400 }
    );
  }

  const supabase = await createAuthedClient();
  const redirectTo = new URL("/api/auth/callback?next=/reset", req.nextUrl.origin).toString();
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  if (error) {
    // Do not tell the caller whether the account exists; delivery problems
    // are reported generically.
    console.error("recovery request failed:", error.code ?? error.message);
    return NextResponse.json(
      { ok: false, code: "delivery_failed", message: "Could not send the reset email right now. Please try again in a moment." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    data: { message: "If that email belongs to an account, a reset link is on its way." },
  });
}
