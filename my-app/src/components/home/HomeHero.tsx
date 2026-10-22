"use client";

import Link from "next/link";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

/**
 * Hero + two direct entry paths (Home block 3).
 *
 * `right` carries the server-rendered campaign card so it can read real
 * database stats. The live donor search lives in the request-workbench
 * section further down the page.
 */
export function HomeHero({
  dict,
  right,
}: {
  dict: Dictionary;
  right: React.ReactNode;
}) {
  const h = dict.home.hero;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-10 lg:px-8 lg:pb-24 lg:pt-14">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 lg:items-center">
        {/* Left: editorial copy + paths */}
        <div className="col-span-7 flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-brand-100 px-3 py-1 text-xs font-bold text-brand-700">
              <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-brand-500" />
              {h.badge}
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-ink-600">
              <span aria-hidden className="text-emerald-600">●</span>
              {h.verifiedNote}
            </span>
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl font-extrabold leading-[1.2] tracking-tight text-ink-900 sm:text-4xl xl:text-5xl">
              {h.titleLine1}
              <br />
              <span className="text-brand-500">{h.titleLine2}</span>
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-ink-600 sm:text-lg">
              {h.subtitle}
            </p>
          </div>

          {/* Two direct entry paths */}
          <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
            <div className="group flex flex-col justify-between rounded-2xl border-2 border-brand-200 bg-surface p-5 shadow-sm transition-colors hover:border-brand-500">
              <div>
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-100 text-brand-600">
                  <span aria-hidden className="text-2xl">🚑</span>
                </div>
                <h2 className="text-lg font-bold leading-snug text-ink-900">{h.path1Title}</h2>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-600">{h.path1Body}</p>
              </div>
              <Link
                href="#request-workbench"
                className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand-500 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-brand-600"
              >
                {h.path1Cta}
                <span aria-hidden>→</span>
              </Link>
            </div>

            <div className="group flex flex-col justify-between rounded-2xl border border-ink-200 bg-surface p-5 shadow-sm transition-colors hover:border-accent-500">
              <div>
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-100 text-accent-600">
                  <span aria-hidden className="text-2xl">🩸</span>
                </div>
                <h2 className="text-lg font-bold leading-snug text-ink-900">{h.path2Title}</h2>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-600">{h.path2Body}</p>
              </div>
              <Link
                href="#donor-register"
                className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-ink-100 px-4 py-2.5 text-xs font-bold text-ink-800 transition-colors hover:bg-ink-200"
              >
                {h.path2Cta}
                <span aria-hidden>→</span>
              </Link>
            </div>
          </div>

          {/* Trust strip */}
          <div className="flex flex-wrap items-center gap-6 border-t border-ink-200 pt-4 text-xs text-ink-600">
            <span className="flex items-center gap-2"><span aria-hidden className="text-brand-500">✓</span>{h.trust1}</span>
            <span className="flex items-center gap-2"><span aria-hidden className="text-accent-500">🛡</span>{h.trust2}</span>
            <span className="flex items-center gap-2"><span aria-hidden className="text-emerald-600">🔒</span>{h.trust3}</span>
          </div>
        </div>

        {/* Right: server-rendered campaign card with real DB stats. */}
        <div className="col-span-5" id="hero-card-slot">{right}</div>
      </div>
    </div>
  );
}
