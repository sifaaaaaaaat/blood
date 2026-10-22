import { NextRequest, NextResponse } from "next/server";
import { createAuthedClient } from "@/src/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/oauth — social sign-in entry point.
 *
 * Starts a Supabase OAuth flow for a social provider (e.g. Google). The
 * provider's consent screen redirects back to /api/auth/callback, which
 * exchanges the code for a session — the same callback the magic-link flow
 * already uses, so no extra route or cookie logic is needed here.
 *
 * `next` must be a same-origin relative path (no open redirects). The OAuth
 * provider itself must be enabled in the Supabase dashboard with its client
 * ID/secret, and this origin must be allow-listed in the project's Redirect
 * URLs — without that Supabase returns an error which we surface honestly.
 */
const NEXT_RE = /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/;
/** Only providers the platform actually intends to support. Nothing fake. */
const PROVIDERS = new Set(["google", "facebook", "apple"]);

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { provider?: unknown; next?: unknown }
    | null;

  const provider =
    typeof body?.provider === "string" && PROVIDERS.has(body.provider)
      ? (body.provider as "google" | "facebook" | "apple")
      : null;
  if (!provider) {
    return NextResponse.json(
      { ok: false, code: "validation_error", message: "unsupported sign-in provider" },
      { status: 400 }
    );
  }

  const nextRaw = typeof body?.next === "string" ? body.next : "";
  const next = NEXT_RE.test(nextRaw) ? `?next=${encodeURIComponent(nextRaw)}` : "";

  const supabase = await createAuthedClient();
  const origin = req.nextUrl.origin;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${origin}/api/auth/callback${next}`,
    },
  });
  if (error || !data?.url) {
    return NextResponse.json(
      {
        ok: false,
        code: "auth_error",
        message: error?.message ?? "social sign-in is not available right now",
      },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, data: { url: data.url } });
}
