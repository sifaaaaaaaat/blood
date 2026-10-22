import "server-only";
import { getServiceRoleClient } from "@/src/lib/db";

/**
 * Aggregate availability preview (homepage console).
 *
 * Returns ONLY counts — never donor identity, phone, coordinates or contact
 * fields. The donor count mirrors the matching service's hard filters
 * (availability, unexpired pause, consent, verified phone, no recovery hold,
 * active account) so the number is the honest candidate-signal, not marketing.
 */
export type PreviewResult = {
  donorsAvailable: number;
  banks: number;
  asOf: string;
};

type HeadResult = { count: number | null; error: { message: string } | null };

async function head(query: unknown): Promise<HeadResult> {
  try {
    return (await query) as HeadResult;
  } catch {
    return { count: null, error: { message: "unreachable" } };
  }
}

export async function previewAvailability(opts: {
  divisionId?: number;
  districtId?: number;
  bloodGroup: string;
}): Promise<PreviewResult | null> {
  const supabase = getServiceRoleClient();
  if (!supabase) return null;

  // Donor join chain through the location ids so the count respects the same
  // geography the matching tiers use (district > division upstream).
  const donorBase = { count: "exact" as const, head: true };
  const donorQuery = supabase
    .from("donor_profiles")
    .select("user_id, districts!inner(division_id)", donorBase)
    .eq("blood_group", opts.bloodGroup)
    .eq("availability", "available")
    .or("paused_until.is.null,paused_until.lte.now()")
    .eq("notify_consent", true)
    .not("contact_numbers.verified_at", "is", null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let donors: unknown = donorQuery as any;
  if (opts.districtId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    donors = (donorQuery as any).eq("upazilas.district_id", opts.districtId);
  } else if (opts.divisionId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    donors = (donorQuery as any).eq("districts.division_id", opts.divisionId);
  }

  const [dRes, bRes] = await Promise.all([
    head(donors),
    head(
      supabase
        .from("blood_banks")
        .select("id", donorBase)
        .eq("is_published", true)
        .eq(opts.districtId ? "district_id" : "division_id", (opts.districtId ?? opts.divisionId)!)
    ),
  ]);

  // One unreliable count → the honest fallback (null) upstream, never 0-that-looks-real.
  if (dRes.count === null && bRes.count === null) return null;

  return {
    donorsAvailable: dRes.count ?? 0,
    banks: bRes.count ?? 0,
    asOf: new Date().toISOString(),
  };
}
