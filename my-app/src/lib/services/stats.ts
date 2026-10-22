import "server-only";
import { getServiceRoleClient } from "@/src/lib/db";

/**
 * Homepage statistics (Phase 11B).
 *
 * These are GENUINE counts read from this platform's own database — never
 * simulated, projected or padded. If the database is unreachable the caller
 * receives `null` and the UI must render an honest pending state instead of
 * zeros-that-look-real.
 */
export type PlatformStats = {
  donorsRegistered: number;
  donorsAvailable: number;
  requestsCreated: number;
  requestsConnected: number;
  /** Server clock when the counts were read (ISO). */
  asOf: string;
};

/**
 * Never let a slow/unreachable database hang the homepage: cap the whole
 * count round-trip and degrade to the honest pending state instead.
 */
const STATS_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function getPlatformStats(): Promise<PlatformStats | null> {
  try {
    return await withTimeout(readStats(), STATS_TIMEOUT_MS);
  } catch {
    // Missing env vars or unreachable database → honest pending state upstream.
    return null;
  }
}

type CountResult = { count: number | null; error: { message: string } | null };
type VerifiedCount = { count: number; error: null };

async function readStats(): Promise<PlatformStats | null> {
  const supabase = getServiceRoleClient();

  /** Run one head-count query and normalise it; null on any failure. */
  async function headCount(builder: unknown): Promise<VerifiedCount | null> {
    try {
      const res = (await builder) as CountResult;
      return res.error === null && typeof res.count === "number"
        ? { count: res.count, error: null }
        : null;
    } catch {
      return null;
    }
  }

  const [donors, available, requests, connected] = await Promise.all([
    headCount(supabase.from("donor_profiles").select("user_id", { count: "exact", head: true })),
    headCount(
      supabase
        .from("donor_profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("availability", "available")
    ),
    headCount(supabase.from("blood_requests").select("id", { count: "exact", head: true })),
    headCount(supabase.from("contact_reveals").select("id", { count: "exact", head: true })),
  ]);

  if (donors === null || available === null || requests === null || connected === null) {
    return null;
  }

  return {
    donorsRegistered: donors.count,
    donorsAvailable: available.count,
    requestsCreated: requests.count,
    requestsConnected: connected.count,
    asOf: new Date().toISOString(),
  };
}
