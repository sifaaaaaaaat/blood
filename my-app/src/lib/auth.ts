/**
 * getAuthUser — Phase 2 auth helper.
 *
 * Reads the Supabase session from request cookies and returns the mapped
 * profile row (which carries role flags). Returns null when the caller is
 * unauthenticated. Route handlers call this first and pass the result to
 * service functions; it performs no writes.
 */
import "server-only";
import { createUserClient } from "./db";

export type AuthUser = {
  id: string;
  displayName: string;
  isDonor: boolean;
  isRequester: boolean;
  isAdmin: boolean;
};

export async function getAuthUser(
  getCookies: () => Promise<{ name: string; value: string }[]>
): Promise<AuthUser | null> {
  const supabase = await createUserClient(getCookies);

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("id, display_name, is_donor, is_requester, is_admin")
    .eq("id", data.user.id)
    .single();

  if (profileErr || !profile) return null;

  return {
    id: profile.id,
    displayName: profile.display_name,
    isDonor: profile.is_donor,
    isRequester: profile.is_requester,
    isAdmin: profile.is_admin,
  };
}
