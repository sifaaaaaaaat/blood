import "server-only";
import { unstable_cache } from "next/cache";
import { getPlatformStats, type PlatformStats } from "./stats";
import { getPublishedBankCount, listPublishedBanks, type BloodBankCard } from "./bloodbanks";
import { listUpcomingCamps, type CampCard } from "./camps";
import { listDivisions, type LocationOption } from "./locations";
import { listPublished, type Article, type ContentCategory } from "./content";

/**
 * Time-based server cache for slowly-changing public reads.
 *
 * Every page render previously hit PostgREST several times even when rows
 * had not changed in months. These wrappers keep the exact same call
 * signatures and Result contracts but serve a cached snapshot for a short
 * TTL — long enough to absorb the per-request round-trips on warm invocations,
 * short enough that admin edits surface within a minute.
 */

const revalidate = (seconds: number) => ({ revalidate: seconds });

const platformStats = unstable_cache(getPlatformStats, ["roktosathi:stats"], revalidate(60));
const bankCount = unstable_cache(getPublishedBankCount, ["roktosathi:banks-count"], revalidate(60));

export async function getPlatformStatsCached(): Promise<PlatformStats | null> {
  return platformStats();
}

export async function getPublishedBankCountCached(): Promise<number | null> {
  return bankCount();
}

/** Published camps, newest-first by start date (keyed by requested limit). */
export async function listUpcomingCampsCached(limit?: number): Promise<ResultLike<CampCard[]>> {
  const n = limit ?? 50;
  return unstable_cache(
    () => listUpcomingCamps(n),
    ["roktosathi:camps", String(n)],
    revalidate(60)
  )();
}

/** Published directory banks (keyed by the full serialized filter). */
export async function listPublishedBanksCached(
  filter: Parameters<typeof listPublishedBanks>[0]
): Promise<ResultLike<BloodBankCard[]>> {
  const cacheable = { ...filter };
  // Volatile surface text makes keys unbounded; keep it but hash it down.
  const key = stableKey(cacheable);
  return unstable_cache(
    () => listPublishedBanks(cacheable),
    ["roktosathi:banks", key],
    revalidate(60)
  )();
}

const divisions = unstable_cache(listDivisions, ["roktosathi:divisions"], revalidate(600));

export async function listDivisionsCached(): Promise<ResultLike<LocationOption[]>> {
  return divisions();
}

/** Published content articles per category (keyed by category + limit). */
export async function listPublishedCached(
  category: ContentCategory,
  limit = 50
): Promise<ResultLike<Article[]>> {
  return unstable_cache(
    () => listPublished(category, limit),
    ["roktosathi:content", category, String(limit)],
    revalidate(120)
  )();
}

/** Minimal structural type so this module does not need the service Result. */
type ResultLike<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/** Deterministic short key for a JSON-safe filter object. */
function stableKey(value: Record<string, unknown>): string {
  const json = JSON.stringify(value, Object.keys(value).sort());
  // eslint-disable-next-line no-control-regex
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0) + "-" + json.length;
}
