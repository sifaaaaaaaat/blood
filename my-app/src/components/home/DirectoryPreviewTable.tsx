import Link from "next/link";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import type { BloodBankCard } from "@/src/lib/services/bloodbanks";

/**
 * Directory preview table (homepage block). Renders the REAL published blood
 * banks — the same rows as /directory — with their last reported stock per
 * group. No bank is ever invented; an empty directory shows the honest
 * pending state and links to the full page with its filters.
 */
export function DirectoryPreviewTable({
  dict,
  locale,
  banks,
}: {
  dict: Dictionary;
  locale: "en" | "bn";
  banks: BloodBankCard[];
}) {
  const d = dict.home.directory;
  const full = dict.directory;
  const bn = locale === "bn";

  return (
    <div className="mx-auto max-w-7xl px-4 lg:px-8">
      <div className="mb-8 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-600">
            <span aria-hidden>▦</span>{d.tag}
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight text-ink-900 lg:text-3xl">{d.title}</h2>
          <p className="mt-1 text-xs text-ink-600 sm:text-sm">{d.subtitle}</p>
        </div>
        <Link
          href="/directory"
          className="inline-flex items-center gap-1 self-start rounded-lg bg-brand-500 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-brand-600 lg:self-auto"
        >
          {full.cta}<span aria-hidden>→</span>
        </Link>
      </div>

      {banks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-canvas px-6 py-10 text-center">
          <p className="mx-auto max-w-lg text-sm leading-relaxed text-ink-600">{full.pending}</p>
          <Link href="/directory" className="mt-3 inline-block text-sm font-semibold text-brand-600 underline">
            {d.emptyCta}
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-ink-200 bg-surface shadow-sm">
          {/* Mobile: cards */}
          <ul className="divide-y divide-ink-200 md:hidden">
            {banks.map((b) => (
              <li key={b.id} className="p-4">
                <p className="font-bold text-ink-900">{bn ? b.nameBn || b.name : b.name}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-600">
                  <span aria-hidden>📍</span>{b.address}
                </p>
                <p className="mt-1 text-[11px] text-ink-500">{bn ? b.districtNameBn : b.districtName}</p>
                {b.stock && b.stock.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {b.stock.map((s) => (
                      <span key={s.group} className="rounded bg-ink-100 px-2 py-0.5 text-[11px] font-bold text-ink-800">
                        {s.group} ({s.units})
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-ink-400">{full.card.stockSource}</p>
                )}
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 bg-canvas text-[11px] uppercase tracking-wider text-ink-700">
                  <th className="px-6 py-4">{d.thName}</th>
                  <th className="px-4 py-4">{d.thKind}</th>
                  <th className="px-4 py-4">{d.thStock}</th>
                  <th className="px-4 py-4">{d.thUpdated}</th>
                  <th className="px-6 py-4 text-right">{d.thPhone}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {banks.map((b) => {
                  const last = b.stock?.reduce<string | null>(
                    (acc, s) => (acc === null || s.reportedAt > acc ? s.reportedAt : acc), null
                  );
                  return (
                    <tr key={b.id} className="transition-colors hover:bg-canvas">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-[10px] font-bold text-brand-700">
                            {(bn ? b.nameBn || b.name : b.name).slice(0, 2)}
                          </div>
                          <div>
                            <span className="block text-sm font-bold text-ink-900">{bn ? b.nameBn || b.name : b.name}</span>
                            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-600">
                              <span aria-hidden>📍</span>{b.address}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold text-accent-700">
                          {full.kinds[b.kind as keyof typeof full.kinds] ?? b.kind}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        {b.stock && b.stock.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {b.stock.map((s) => (
                              <span key={s.group} className="rounded bg-ink-100 px-2 py-0.5 font-bold text-ink-800">
                                {s.group} ({s.units})
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-ink-400">{full.card.groupsUnknown}</span>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        {last ? (
                          <time dateTime={last} className="font-bold text-emerald-600">
                            {new Date(last).toLocaleString(bn ? "bn-BD" : "en-GB", { dateStyle: "medium", timeStyle: "short" })}
                          </time>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {b.phonePublic ? (
                          <a
                            href={`tel:${b.phonePublic}`}
                            className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 font-bold text-brand-700 transition-colors hover:bg-brand-50"
                          >
                            <span aria-hidden>☎</span>{b.phonePublic}
                          </a>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col items-center justify-between gap-2 border-t border-ink-200 bg-canvas p-4 text-xs text-ink-600 sm:flex-row">
            <span>{d.footnote}</span>
            <Link href="/directory" className="flex items-center gap-1 font-bold text-brand-600 hover:underline">
              {d.allCta}<span aria-hidden>→</span>
            </Link>
          </div>          </div>
      )}
    </div>
  );
}
