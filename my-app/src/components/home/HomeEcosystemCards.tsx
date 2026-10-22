import Link from "next/link";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

/**
 * Three-stakeholder ecosystem cards (homepage). Pure presentation — each CTA
 * deep-links to a real route; the card copy is honest about what the platform
 * does today (no endorsement badges, no fabricated partner logos).
 */
export function HomeEcosystemCards({ dict }: { dict: Dictionary }) {
  const h = dict.home.ecosystem;
  const cards = [
    { n: h.card1Num, tag: h.card1Tag, title: h.card1Title, body: h.card1Body, bullets: [h.card1B1, h.card1B2, h.card1B3], cta: h.card1Cta, href: "/requests/new", featured: false },
    { n: h.card2Num, tag: h.card2Tag, title: h.card2Title, body: h.card2Body, bullets: [h.card2B1, h.card2B2, h.card2B3], cta: h.card2Cta, href: "/register", featured: true },
    { n: h.card3Num, tag: h.card3Tag, title: h.card3Title, body: h.card3Body, bullets: [h.card3B1, h.card3B2, h.card3B3], cta: h.card3Cta, href: "/directory", featured: false },
  ] as const;

  return (
    <div className="mx-auto max-w-7xl px-4 lg:px-8">
      <div className="mb-12 flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand-700">
            <span aria-hidden>◎</span>{h.tag}
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight text-ink-900 lg:text-3xl">{h.title}</h2>
        </div>
        <p className="max-w-md text-sm text-ink-600">{h.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
        {cards.map((c) => (
          <div
            key={c.n}
            className={`relative flex flex-col justify-between overflow-hidden rounded-2xl bg-surface p-6 shadow-sm transition-all lg:p-8 ${
              c.featured ? "border-2 border-brand-500 shadow-md" : "border border-ink-200 hover:border-brand-300"
            }`}
          >
            {c.featured ? (
              <span className="absolute right-0 top-0 rounded-bl-xl bg-brand-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                {h.privacyFirst}
              </span>
            ) : null}
            <div>
              <div className="mb-5 flex items-center justify-between">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl text-xl font-bold ${
                  c.featured ? "bg-brand-500 text-white" : c.n === h.card1Num ? "bg-brand-100 text-brand-600" : "bg-accent-100 text-accent-600"
                }`}>
                  {c.n}
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
                  c.featured ? "bg-brand-100 text-brand-700" : c.n === h.card1Num ? "bg-brand-50 text-brand-700" : "bg-canvas text-accent-700"
                }`}>
                  {c.tag}
                </span>
              </div>
              <h3 className="mb-2 text-xl font-bold text-ink-900">{c.title}</h3>
              <p className="mb-6 text-xs leading-relaxed text-ink-600">{c.body}</p>
              <ul className="mb-6 space-y-3 text-xs">
                {c.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2.5">
                    <span aria-hidden className={`shrink-0 mt-0.5 ${c.featured ? "text-accent-600" : "text-brand-600"}`}>•</span>
                    <span className="text-ink-800">{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Link
              href={c.href}
              className={`flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-center text-xs font-bold transition-all ${
                c.featured
                  ? "bg-brand-500 text-white shadow-sm hover:bg-brand-600"
                  : "bg-canvas text-ink-900 hover:bg-brand-500 hover:text-white"
              }`}
            >
              {c.cta}<span aria-hidden>→</span>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
