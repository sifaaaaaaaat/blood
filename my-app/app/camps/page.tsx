import type { Metadata } from "next";
import Link from "next/link";
import { getDictionary } from "@/src/lib/i18n/server";
import { listUpcomingCampsCached } from "@/src/lib/services/cached-reads";
import type { CampCard } from "@/src/lib/services/camps";
import { Badge, Card, EmptyState, SectionHeading } from "@/src/components/ui/primitives";
import { ScrollReveal } from "@/src/components/motion/ScrollReveal";

export const metadata: Metadata = {
  title: "Camps",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

/** Module-level helper: the clock is read here, once per request, outside of
 * the component body (render purity invariants). */
function partitionByNow(camps: CampCard[]): { upcoming: CampCard[]; past: CampCard[] } {
  const now = Date.now();
  return {
    upcoming: camps.filter((x) => Date.parse(x.endsAt) >= now),
    past: camps.filter((x) => Date.parse(x.endsAt) < now),
  };
}

export default async function CampsPage() {
  const { dict, locale } = await getDictionary();
  const c = dict.camps;

  // Only real, published, admin-vetted camps — an honest empty state when
  // none exist yet (nothing is ever synthesized here).
  const result = await listUpcomingCampsCached();
  const camps = (result.ok ? result.data : []) as CampCard[];
  const { upcoming, past } = partitionByNow(camps);

  const fmt = (s: string) =>
    new Intl.DateTimeFormat(locale === "bn" ? "bn" : "en", { dateStyle: "medium" }).format(new Date(s));

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <SectionHeading title={c.title} subtitle={c.subtitle} />
      <div className="mt-8 grid gap-4">
        {camps.length === 0 ? (
          <EmptyState message={c.empty} />
        ) : (
          <>
            <ScrollReveal as="ul" className="grid gap-3 md:grid-cols-2" animateChildren>
              {upcoming.map((x) => (
                <li key={x.id}>
                  <Card className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="text-base font-bold text-ink-900">{locale === "bn" && x.nameBn ? x.nameBn : x.name}</h2>
                      <Badge>{fmt(x.startsAt)}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-ink-600">{x.orgName}</p>
                    <p className="mt-2 text-sm text-ink-600">
                      {[x.divisionName, x.districtName, x.locationText].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-3 border-t border-ink-100 pt-2 text-xs text-ink-500">
                      {c.sourceLabel}{x.sourceNote}
                    </p>
                  </Card>
                </li>
              ))}
            </ScrollReveal>
            {past.length > 0 ? (
              <p className="rounded-card border border-dashed border-ink-300 bg-ink-50 px-6 py-4 text-sm text-ink-500">
                {c.pastNote.replace("{n}", String(past.length))}
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="mt-8">
        <Link href="/" className="text-sm font-semibold text-red-700 underline hover:no-underline">
          {dict.pending.backHome}
        </Link>
      </div>
    </section>
  );
}
