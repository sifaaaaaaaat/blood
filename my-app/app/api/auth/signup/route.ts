import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

/** POST /api/auth/signup — Email + password sign-up.
 *
 * Registers a new user with Supabase using email and password.
 * On success, Supabase creates the auth user and the public.handle_new_user
 * trigger provisions the profile row (Phase 2). The session cookie is set
 * via the authed client so the browser immediately holds a real session.
 *
 * On failure, returns useful messages for weak passwords, duplicate emails,
 * etc. Does NOT send a magic-link sign-in email.
 *
 * When the Supabase project requires email confirmation, signUp() creates the
 * user but returns no session. `needsConfirmation` tells the client to ask for
 * the inbox confirmation step instead of expecting an authenticated session.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  // Basic validation
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "A valid email address is required" },
      { status: 400 }
    );
  }

  if (password.length === 0) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "A password is required" },
      { status: 400 }
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { ok: false, code: "weak_password", message: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const supabase = await createAuthedClient();
  const { error, data } = await supabase.auth.signUp({
    email,
    password,
    // Do not auto-create email confirmation - we allow password-only login
    // emailConfirm: false, // not needed for password auth
  });

  if (error) {
    const errorMessage = error.message;
    const code = error.code;

    if (code === "weak_password") {
      return NextResponse.json(
        { ok: false, code: "weak_password", message: "Password is too weak. Use at least 8 characters." },
        { status: 400 }
      );
    }

    if (code === "duplicate_email") {
      return NextResponse.json(
        { ok: false, code: "duplicate_email", message: "An account with this email already exists." },
        { status: 400 }
      );
    }

    if (code === "invalid_email") {
      return NextResponse.json(
        { ok: false, code: "validation_error", message: "The email address is invalid." },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { ok: false, code: "auth_error", message: errorMessage || "Sign-up problem. Please try again." },
      { status: 400 }
    );
  }

  // Successful sign-up — data.user contains the new auth user
  // The public.handle_new_user trigger should have created the profile row
  return NextResponse.json({
    ok: true,
    data: { user: data.user },
    needsConfirmation: !data.session,
  });
}