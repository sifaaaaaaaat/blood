import "server-only";
import { cookies } from "next/headers";
import { getAuthUser, type AuthUser } from "./auth";

/**
 * Server-component session helper (Phase 11D).
 *
 * Wraps getAuthUser for RSC use: Server Components may not write cookies, but
 * the underlying client never needs to during a read-only render. Returns
 * null whenever anything is unavailable (no session, DB unreachable) so pages
 * degrade to their signed-out state instead of erroring.
 */
export async function getServerSession(): Promise<AuthUser | null> {
  try {
    const store = await cookies();
    return await getAuthUser(async () =>
      store.getAll().map((c) => ({ name: c.name, value: c.value }))
    );
  } catch {
    return null;
  }
}
