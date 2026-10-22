import Link from "next/link";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import type { CampCard } from "@/src/lib/services/camps";

/** Stale-date comparison lives OUTSIDE the component (React-compiler-safe). */
function partitionCamps(list: CampCard[]): { upcoming: CampCard[]; past: number } {
  const nowMs = Date.now();
  const upcoming = list.filter((c) => Date.parse(c.endsAt) >= nowMs);
  return { upcoming, past: list.length - upcoming.length };
}

/**
 * Camps section (homepage). Renders ONLY real published camps — the same
 * surface as /camps. No camp images exist in the product yet, so cards use a
 * neutral gradient header instead of invented photo assets; participation
 * links go to the full camps page rather than a fake confirm dialog.
 */
export function HomeCampsSection({ dict, camps }: { dict: Dictionary; camps: CampCard[] }) {
  const d = dict.home.camps;
  const full = dict.camps;
  const { upcoming, past } = partitionCamps(camps);

  return (
    <div className="mx-auto max-w-7xl px-4 lg:px-8">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand-700">
            <span aria-hidden>📣</span>{d.tag}
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight text-ink-900 lg:text-3xl">{d.title}</h2>
        </div>
        <Link href="/camps" className="hidden items-center gap-1 text-xs font-bold text-brand-600 hover:underline sm:flex">
          {full.viewAll}<span aria-hidden>→</span>
        </Link>
      </div>

      {upcoming.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-canvas px-6 py-10 text-center">
          <p className="mx-auto max-w-lg text-sm leading-relaxed text-ink-600">{full.empty}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {upcoming.map((c) => {
            const start = new Date(c.startsAt);
            return (
              <article
                key={c.id}
                className="group flex flex-col justify-between overflow-hidden rounded-2xl border border-ink-200 bg-surface shadow-sm transition-shadow hover:shadow-md"
              >
                <div>
                  {/* Neutral date band (no invented photography) */}
                  <div className="relative flex h-28 items-center justify-between bg-gradient-to-r from-brand-700 to-brand-500 px-5 text-white">
                    <span className="rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-bold text-brand-700">
                      {start.toLocaleString("bn-BD", { dateStyle: "full", timeStyle: undefined })}
                    </span>
                    <span className="text-[11px] font-semibold text-white/90">
                      {c.endsAt ? `${new Date(c.endsAt).toLocaleDateString("bn-BD", { day: "numeric", month: "short" })} পর্যন্ত` : ""}
                    </span>
                  </div>
                  <div className="p-5">
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-accent-600">
                      {c.orgName}
                    </span>
                    <h4 className="mt-1 text-base font-bold text-ink-900 transition-colors group-hover:text-brand-700">
                      {c.nameBn || c.name}
                    </h4>
                    <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-600">
                      <span aria-hidden>📍</span>{c.locationText}
                      {c.districtName ? ` · ${c.districtName}` : ""}
                    </p>
                    {c.sourceNote ? (
                      <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-ink-500">{c.sourceNote}</p>
                    ) : null}
                  </div>
                </div>
                <div className="px-5 pb-5">
                  <Link
                    href="/camps"
                    className="flex w-full items-center justify-center rounded-xl bg-canvas px-4 py-2.5 text-xs font-bold text-ink-900 transition-colors hover:bg-brand-500 hover:text-white"
                  >
                    {d.detailsCta}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {past > 0 ? (
        <p className="mt-4 text-[11px] text-ink-500">{full.pastNote.replace("{n}", String(past))}</p>
      ) : null}
    </div>
  );
}
