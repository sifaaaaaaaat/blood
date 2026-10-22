import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/callback — completes the OAuth sign-in that /api/auth/oauth
 * started. The provider redirects here with ?code=…; this route exchanges the
 * code for a session (PKCE), which sets the auth cookies, then forwards the
 * user to `next` (same-origin relative only) or /profile.
 */
const NEXT_RE = /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/;

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  const nextRaw = req.nextUrl.searchParams.get("next") ?? "";
  const next = NEXT_RE.test(nextRaw) ? nextRaw : "/profile";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createAuthedClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=oauth_exchange_failed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
