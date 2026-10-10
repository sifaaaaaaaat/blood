import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "server-only";

/**
 * Supabase clients — Phase 2 foundation.
 *
 * Two distinct clients:
 *  · createUserClient()      — per-request user client; RLS enforced.
 *  · getServiceRoleClient()  — server-only; bypasses RLS for admin/audit/
 *                              notification fan-out. NEVER import from a
 *                              client component ("server-only" guards it).
 *
 * Requires env vars (never committed): NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * See .env.example at the repo root.
 */

export type Sessions = Awaited<ReturnType<typeof createServerClient<"sessions">>["auth"]["getSession"]>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to my-app/.env.local from .env.example — never commit the value.`
    );
  }
  return value;
}

export function getServiceRoleClient(): SupabaseClient {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

/** Per-request user client bound to the request's cookies (RLS enforced). */
export async function createUserClient(
  getCookies: () => Promise<{ name: string; value: string }[]>
): Promise<SupabaseClient> {
  const cookies = await getCookies();
  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll: () => cookies,
        setAll: () => {
          // Route handlers can write cookies via Next's response; Phase 3 wires
          // this properly when auth flows land.
        },
      },
    }
  );
}

// parseCookieHeader is re-exported for convenience in route handlers.
export { parseCookieHeader };
