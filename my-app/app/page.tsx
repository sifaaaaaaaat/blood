import type { Metadata } from "next";
import Link from "next/link";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { getPlatformStatsCached } from "@/src/lib/services/cached-reads";
import { getPublishedBankCountCached } from "@/src/lib/services/cached-reads";
import { listUpcomingCampsCached } from "@/src/lib/services/cached-reads";
import { listPublishedBanksCached } from "@/src/lib/services/cached-reads";
import { listDivisionsCached } from "@/src/lib/services/cached-reads";
import type { LocationOption } from "@/src/lib/services/locations";
import { HomeHero } from "@/src/components/home/HomeHero";
import { HeroCampaignCard } from "@/src/components/home/HeroCampaignCard";
import { HomeEcosystemCards } from "@/src/components/home/HomeEcosystemCards";
import { HomeWorkbench, type WorkbenchPrefill } from "@/src/components/home/HomeWorkbench";
import { DirectoryPreviewTable } from "@/src/components/home/DirectoryPreviewTable";
import { HomeEligibility } from "@/src/components/home/HomeEligibility";
import { HomeCampsSection } from "@/src/components/home/HomeCamps";
import { HomeDonorRegistration } from "@/src/components/home/HomeDonorRegistration";
import { ScrollReveal } from "@/src/components/motion/ScrollReveal";

/**
 * Homepage — campaign composition (UI-integration pass).
 *
 * Approved reference structure: awareness strip → hero with two entry paths
 * and a live availability console → real-numbers row → three stakeholder
 * cards → request workbench → directory preview → eligibility assessment →
 * camps → donor registration → trust marks → final CTA.
 *
 * Every interactive element is backed by the real backend (matching preview,
 * request creation, signup/registration); empty states stay empty.
 */
export const dynamic = "force-dynamic";

const GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const;

function readPrefill(params: Record<string, string | string[] | undefined>): WorkbenchPrefill {
  const one = (k: string): string | undefined => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const bg = one("bg");
  const intId = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    bloodGroup: bg && (GROUPS as readonly string[]).includes(bg) ? bg : undefined,
    hospital: one("hospital")?.slice(0, 120),
    divisionId: intId(one("division")),
    districtId: intId(one("district")),
    upazilaId: intId(one("upazila")),
  };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { dict, locale } = await getDictionary();
  const [session, params] = await Promise.all([getServerSession(), searchParams]);
  const prefill = readPrefill(params);

  const [stats, camps, banks, divisions, banksTotal] = await Promise.all([
    getPlatformStatsCached(),
    listUpcomingCampsCached(3),
    listPublishedBanksCached({ limit: 4, offset: 0 }),
    listDivisionsCached(),
    getPublishedBankCountCached(),
  ]);

  const signedIn = Boolean(session);
  const home = dict.home;

  return (
    <div className="flex flex-col">
      {/* 1. Awareness campaign strip */}
      <aside className="bg-gradient-to-r from-brand-700 via-brand-500 to-brand-700 text-white shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-4 py-2 text-xs sm:flex-row lg:px-8">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider backdrop-blur">
              {home.banner.tag}
            </span>
            <strong className="font-semibold tracking-tight">{home.banner.headline}</strong>
          </div>
          <div className="flex items-center gap-3 text-[11px] font-medium sm:gap-4">
            <Link href="#eligibility" className="flex items-center gap-1 hover:underline">
              {home.banner.eligibilityLink}
              <span aria-hidden>→</span>
            </Link>
            <span className="hidden items-center gap-3 sm:flex">
              <span className="flex items-center gap-1 text-brand-100">
                <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
                {home.banner.helplineLabel}:
              </span>
              <a className="font-bold underline hover:text-brand-100" href="tel:16263">16263</a>
              <span className="opacity-50">|</span>
              <a className="font-bold underline hover:text-brand-100" href="tel:999">999</a>
            </span>
          </div>
        </div>
      </aside>

      {/* 2. Hero + two direct entry paths; right column carries the
          server-rendered campaign card with real platform stats. */}
      <section id="direct-request" className="grid-texture relative overflow-hidden border-b border-ink-200 bg-paper">
        <HomeHero
          dict={dict}
          right={
            <HeroCampaignCard dict={dict} locale={locale} stats={stats} banksPublished={banksTotal} />
          }
        />
      </section>

      {/* 4. Three-stakeholder ecosystem cards */}
      <ScrollReveal as="section" id="ecosystem" className="border-b border-ink-200 bg-surface py-16">
        <HomeEcosystemCards dict={dict} />
      </ScrollReveal>

      {/* 5. Request workbench (real POST /api/requests flow) */}
      <ScrollReveal as="section" id="request-workbench" className="border-b border-ink-200 bg-canvas py-16">
        <HomeWorkbench dict={dict} prefill={prefill} signedIn={signedIn} />
      </ScrollReveal>

      {/* 6. Blood-bank directory preview (real published rows only) */}
      <ScrollReveal as="section" id="directory" className="border-b border-ink-200 bg-surface py-16">
        <DirectoryPreviewTable dict={dict} locale={locale} banks={banks.ok ? banks.data : []} />
      </ScrollReveal>

      {/* 7. Eligibility guide + interactive assessment */}
      <ScrollReveal as="section" id="eligibility" className="border-b border-ink-200 bg-canvas py-16">
        <HomeEligibility dict={dict} />
      </ScrollReveal>

      {/* 8. Camps (real published camps; honest empty state) */}
      <ScrollReveal as="section" id="camps" className="border-b border-ink-200 bg-surface py-16">
        <HomeCampsSection dict={dict} camps={camps.ok ? camps.data : []} />
      </ScrollReveal>

      {/* 9. Donor registration — session-aware, real flows only */}
      <ScrollReveal as="section" id="donor-register" className="border-b border-ink-200 bg-canvas py-16">
        <HomeDonorRegistration dict={dict} signedIn={signedIn} isDonor={Boolean(session?.isDonor)} />
      </ScrollReveal>

      {/* 10. Trust marks (honest capability claims, no institutional logos) */}
      <ScrollReveal as="section" className="border-t border-ink-200 bg-white py-10">
        <div className="mx-auto max-w-7xl px-4 lg:px-8">
          <p className="text-center text-[11px] font-bold uppercase tracking-widest text-ink-400">
            {home.trustHeading}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-xs text-ink-600">
            <span className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="h-2 w-2 rounded-full bg-brand-500" /> {home.trustVoluntary}
            </span>
            <span className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="h-2 w-2 rounded-full bg-accent-500" /> {home.trustPrivacy}
            </span>
            <span className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="h-2 w-2 rounded-full bg-brand-700" /> {home.trustNonprofit}
            </span>
          </div>
        </div>
      </ScrollReveal>

      {/* 11. Final CTA */}
      <ScrollReveal as="section" className="bg-brand-700 text-white" y={16} duration={0.5}>
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">{dict.finalCta.title}</h2>
            <p className="mt-1 max-w-xl text-brand-100">{dict.finalCta.body}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/register"
              className="inline-flex h-12 items-center justify-center rounded-xl bg-white px-6 text-base font-semibold text-brand-700 shadow-sm transition-colors hover:bg-brand-50"
            >
              {dict.finalCta.ctaDonate}
            </Link>
            <Link
              href="/requests/new"
              className="inline-flex h-12 items-center justify-center rounded-xl border border-white/40 px-6 text-base font-semibold text-white transition-colors hover:bg-brand-800"
            >
              {dict.finalCta.ctaRequest}
            </Link>
          </div>
        </div>
      </ScrollReveal>
    </div>
  );
}
