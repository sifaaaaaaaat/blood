import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signout — Phase 11D. Invalidates the Supabase session and
 * clears every session cookie so the browser really is signed out
 * (supabase-js only removes cookies when a client can write them —
 * createAuthedClient writes through next/headers).
 */
export async function POST(req: NextRequest) {
  const supabase = await createAuthedClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    return NextResponse.json({ ok: false, code: "auth_error", message: error.message }, { status: 400 });
  }
  return NextResponse.redirect(new URL("/", req.nextUrl.origin), { status: 303 });
}
