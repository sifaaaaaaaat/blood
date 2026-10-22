"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

/**
 * Eligibility block (homepage): left column — truthful guideline card that
 * NEVER invents clinical rules (weights/haemoglobin numbers stay out until a
 * qualified source approves them); right column — interactive 5-question
 * micro-assessment mirroring the reference UI, where every YES/FULL state is
 * calculated in the browser. The final "consult a professional" path stays
 * the ONLY realistic instruction.
 */
export function HomeEligibility({ dict }: { dict: Dictionary }) {
  const e = dict.home.eligibility;

  const questions = useMemo(
    () => [e.q1, e.q2, e.q3, e.q4, e.q5] as const,
    [e]
  );
  const points = useMemo(
    () => [e.point1, e.point2, e.point3] as const,
    [e]
  );
  const questionIcons = ["👤", "⚖️", "📅", "💊", "💉"] as const;
  const pointIcons = ["💧", "🗓", "🍚"] as const;
  const [checked, setChecked] = useState<boolean[]>(() => questions.map(() => true));
  const allYes = checked.every(Boolean);
  const pct = Math.round((checked.filter(Boolean).length / Math.max(checked.length, 1)) * 100);

  function setAt(i: number, v: boolean) {
    setChecked((prev) => prev.map((c, idx) => (idx === i ? v : c)));
  }

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
      {/* Left: guide points */}
      <div className="flex flex-col justify-between lg:col-span-5">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand-700">
            <span aria-hidden>＋</span>{e.tag}
          </p>
          <h2 className="text-2xl font-extrabold leading-tight tracking-tight text-ink-900 lg:text-3xl">
            {e.title}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-ink-600 sm:text-sm">{e.intro}</p>

          <div className="mt-6 space-y-4">
            {points.map((pt, i) => (
              <div key={pt.title} className="flex items-start gap-3 rounded-xl border border-ink-200 bg-surface p-3.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-600" aria-hidden>
                  {pointIcons[i % pointIcons.length]}
                </div>
                <div>
                  <h4 className="text-xs font-bold text-ink-900">{pt.title}</h4>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-600">{pt.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 flex items-center gap-3 border-t border-ink-200 pt-4 text-xs text-ink-600">
          <span aria-hidden className="text-brand-500">❤</span>
          <span>{e.disclaimer}</span>
        </div>
      </div>

      {/* Right: interactive assessment card */}
      <div className="lg:col-span-7">
        <div className="rounded-3xl border border-ink-200 bg-surface p-6 shadow-lg lg:p-8" aria-label={e.assessmentAria}>
          <div className="mb-6 flex items-center justify-between border-b border-ink-200 pb-4">
            <div>
              <h3 className="text-lg font-bold text-ink-900">{e.assessmentTitle}</h3>
              <p className="text-xs text-ink-600">{e.assessmentHint}</p>
            </div>
            <div className="text-right">
              <span className={`block text-xl font-extrabold leading-none ${allYes ? "text-emerald-600" : "text-red-600"}`}>
                {pct}%
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{e.scoreLabel}</span>
            </div>
          </div>

          <div className="space-y-3">
            {questions.map((q, i) => {
              const on = checked[i];
              return (
                <label
                  key={q}
                  className={`flex cursor-pointer items-center justify-between rounded-xl border p-3.5 transition-colors ${
                    on ? "border-brand-200 bg-brand-50" : "border-ink-200 bg-canvas"
                  }`}
                >
                  <span className="flex items-center gap-3 text-xs font-semibold text-ink-900">
                    <span aria-hidden className={`text-lg ${on ? "text-brand-600" : "text-ink-400"}`}>
                      {questionIcons[i % questionIcons.length]}
                    </span>
                    {q}
                  </span>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(ev) => setAt(i, ev.target.checked)}
                    className="h-5 w-5 rounded border-ink-300 accent-red-600"
                  />
                </label>
              );
            })}
          </div>

          <div
            role="status"
            className={`mt-6 flex flex-col items-start justify-between gap-3 rounded-xl border p-4 sm:flex-row sm:items-center ${
              allYes ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-warm-50"
            }`}
          >
            <div className="flex items-center gap-3">
              <span aria-hidden className={`text-2xl ${allYes ? "text-emerald-600" : "text-amber-warm-600"}`}>
                {allYes ? "✓" : "!"}
              </span>
              <div>
                <h5 className="text-xs font-bold text-ink-900">{allYes ? e.allYesTitle : e.partialTitle}</h5>
                <p className="text-[11px] text-ink-600">{allYes ? e.allYesBody : e.partialBody}</p>
              </div>
            </div>
            {allYes ? (
              <Link href="#donor-register" className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700">
                {e.readyCta}
              </Link>
            ) : (
              <Link href="/donate" className="shrink-0 rounded-lg bg-amber-warm-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-700">
                {e.readGuideCta}
              </Link>
            )}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-ink-400">{e.assessmentFineprint}</p>
        </div>
      </div>
    </div>
  );
}
