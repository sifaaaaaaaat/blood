import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

/** POST /api/auth/signin — Email + password sign-in.
 * 
 * Authenticates the user with Supabase using email/password.
 * On success, Supabase sets the session cookie through the authed client,
 * and the browser immediately holds a real session. On failure, returns
 * a useful error message for invalid credentials, weak passwords, etc.
 * 
 * Does NOT send a magic-link sign-in email.
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
  const { error, data } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Map common Supabase auth errors to user-friendly messages
    const errorMessage = error.message;
    const code = error.code;

    // Avoid enumerating email addresses — generic error for invalid credentials
    if (code === "invalid_credentials") {
      return NextResponse.json(
        { ok: false, code: "invalid_credentials", message: "Invalid email or password." },
        { status: 400 }
      );
    }

    // Unconfirmed email is a DIFFERENT problem from a wrong password — the
    // account exists but the confirmation link was never used. Surface it
    // honestly instead of pretending the credentials are wrong.
    if (code === "email_not_confirmed") {
      return NextResponse.json(
        {
          ok: false,
          code: "email_not_confirmed",
          message:
            "Please confirm your email first — check your inbox for the confirmation link we sent when you signed up.",
        },
        { status: 400 }
      );
    }

    if (code === "weak_password") {
      return NextResponse.json(
        { ok: false, code: "weak_password", message: "Password is too weak. Use at least 8 characters." },
        { status: 400 }
      );
    }

    if (code === "email_too_long") {
      return NextResponse.json(
        { ok: false, code: "validation_error", message: "Email address is too long." },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { ok: false, code: "auth_error", message: errorMessage || "Sign-in problem. Please check your credentials and try again." },
      { status: 400 }
    );
  }

  // Successful sign-in — data.user contains the auth user
  return NextResponse.json({ ok: true, data: { user: data.user } });
}