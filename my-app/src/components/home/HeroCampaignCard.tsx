import Image from "next/image";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import type { PlatformStats } from "@/src/lib/services/stats";

/**
 * Hero campaign card (server component) — faithful rebuild of the supplied
 * reference card: cream outer frame → campaign artwork → 3-up stats strip →
 * hospital-desk footer with the 16263 emergency call button.
 *
 * The big numbers are REAL platform figures from getPlatformStats():
 *   1. registered donors        (donor_profiles rows)
 *   2. published blood banks    (blood_banks published rows)
 *   3. emergency fulfilment     (contact_reveals / blood_requests)
 * Bangla numerals come from toLocaleString("bn") so they always match the
 * underlying value. When the database is unreachable the strip renders the
 * honest "—" pending state instead of zeros-that-look-real.
 */

const BN = "bn" as const;

function bnNumber(n: number, locale: "en" | "bn"): string {
  return locale === "bn" ? n.toLocaleString(BN) : n.toLocaleString("en");
}

export function HeroCampaignCard({
  dict,
  locale,
  stats,
  banksPublished,
}: {
  dict: Dictionary;
  locale: "en" | "bn";
  stats: PlatformStats | null;
  banksPublished: number | null;
}) {
  const c = dict.home.hero.campaignCard;
  const h = dict.home.hero;

  const donors = stats ? stats.donorsRegistered : null;
  const banks = banksPublished;
  const fulfilPct =
    stats && stats.requestsCreated > 0
      ? Math.round((stats.requestsConnected / stats.requestsCreated) * 1000) / 10
      : null;

  const pctText =
    fulfilPct === null
      ? c.statPending
      : `${(locale === "bn" ? Number(fulfilPct % 1 === 0 ? fulfilPct.toFixed(0) : fulfilPct.toFixed(1)).toLocaleString(BN) : fulfilPct % 1 === 0 ? fulfilPct.toFixed(0) : fulfilPct.toFixed(1))}%`;

  return (
    <div
      data-testid="hero-campaign-card"
      className="mx-auto flex w-full max-w-[430px] flex-col gap-5 overflow-hidden rounded-[38px] border border-[#f0eae6] bg-[#fffbf9] p-5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.08),0_0_1px_1px_rgba(0,0,0,0.05)]"
    >
      {/* Hero visual */}
      <section
        data-purpose="hero-banner"
        className="relative aspect-[4/3.8] w-full overflow-hidden rounded-[26px] shadow-sm"
      >
        <Image
          src={h.posterImage}
          alt={h.posterImageAlt}
          width={1248}
          height={1248}
          sizes="(max-width: 1024px) 90vw, 430px"
          className="h-full w-full object-cover"
          priority
        />
      </section>

      {/* Stats strip — real platform figures */}
      <section
        data-purpose="key-metrics"
        className="grid grid-cols-3 divide-x divide-slate-100 rounded-2xl border border-[#f5ede8] bg-white/80 px-3 py-4 text-center shadow-[0_2px_10px_rgba(0,0,0,0.02)]"
      >
        <div className="flex min-w-0 flex-col items-center justify-center px-1">
          <span className="text-[22px] font-extrabold leading-tight tracking-tight text-[#c92a2a] sm:text-[25px]">
            {donors === null ? c.statPending : `${bnNumber(donors, locale)}+`}
          </span>
          <span className="mt-1 min-w-0 break-words px-1 text-center text-[10px] font-semibold leading-tight text-slate-500 sm:text-xs">
            {c.statDonors}
          </span>
        </div>
        <div className="flex min-w-0 flex-col items-center justify-center px-1">
          <span className="text-[22px] font-extrabold leading-tight tracking-tight text-[#111827] sm:text-[25px]">
            {banks === null ? c.statPending : `${bnNumber(banks, locale)}+`}
          </span>
          <span className="mt-1 min-w-0 break-words px-1 text-center text-[10px] font-semibold leading-tight text-slate-500 sm:text-xs">
            {c.statBanks}
          </span>
        </div>
        <div className="flex min-w-0 flex-col items-center justify-center px-1">
          <span className="text-[22px] font-extrabold leading-tight tracking-tight text-[#0284c7] sm:text-[25px]">
            {pctText}
          </span>
          <span className="mt-1 min-w-0 break-words px-1 text-center text-[10px] font-semibold leading-tight text-slate-500 sm:text-xs">
            {c.statResponse}
          </span>
        </div>
      </section>

      {/* Footer: hospital desk + hotline */}
      <footer
        data-purpose="hospital-desk-and-hotline"
        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-3 border-t border-[#f1eae5] pb-1 pt-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-red-100 bg-slate-50 p-1.5 shadow-sm sm:h-11 sm:w-11">
            <svg className="h-full w-full" fill="none" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <rect fill="#E2E8F0" height="28" rx="2" stroke="#94A3B8" strokeWidth="2" width="28" x="10" y="14" />
              <rect fill="#CBD5E1" height="8" rx="1.5" stroke="#94A3B8" strokeWidth="2" width="12" x="18" y="6" />
              <path d="M24 20V30M19 25H29" stroke="#EF4444" strokeLinecap="round" strokeWidth="3" />
              <rect fill="#64748B" height="8" width="4" x="14" y="34" />
              <rect fill="#64748B" height="8" width="4" x="30" y="34" />
              <rect fill="#3B82F6" height="8" width="4" x="22" y="34" />
            </svg>
          </div>
          <div className="flex min-w-0 flex-col text-left">
            <h2 className="text-[13px] font-bold leading-snug text-slate-900 break-words sm:text-[15px]">{c.deskTitle}</h2>
            <p className="mt-0.5 text-[11px] font-medium leading-tight text-slate-500 break-words sm:text-xs">{c.deskSubtitle}</p>
          </div>
        </div>

        <a
          href="tel:16263"
          aria-label={c.hotlineAria}
          data-purpose="emergency-hotline-button"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[#fbd5d5] bg-[#fde8e8] px-3 py-1.5 text-sm font-bold text-[#b91c1c] transition-all hover:bg-[#fad2d2] active:scale-95 sm:px-4 sm:py-2 sm:text-base"
        >
          <svg className="h-4 w-4 -rotate-12 fill-current" viewBox="0 0 24 24" aria-hidden>
            <path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
          </svg>
          <span className="tracking-wide">{locale === "bn" ? "১৬২৬৩" : "16263"}</span>
        </a>
      </footer>
    </div>
  );
}
