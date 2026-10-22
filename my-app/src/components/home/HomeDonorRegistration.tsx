"use client";

import Link from "next/link";
import { RegisterWizard } from "@/src/components/donor/RegisterWizard";
import { SignUpForm } from "@/src/components/donor/SignUpForm";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

/**
 * Donor-registration block (homepage) — session-aware, all real flows:
 *  · signed-out  → SignUpForm (real signup; deep-links back to #donor-register)
 *  · signed-in, not donor → the real RegisterWizard (posts /api/donors/register)
 *  · donor       → profile CTA (registration cannot be double-submitted)
 * The reference's "verification SMS sent" alert is intentionally NOT used:
 * the platform must never fake a phone-verification that did not happen.
 */
export function HomeDonorRegistration({
  dict,
  signedIn,
  isDonor,
}: {
  dict: Dictionary;
  signedIn: boolean;
  isDonor: boolean;
}) {
  const d = dict.home.donorRegister;
  const r = dict.register;
  const a = dict.auth;

  return (
    <div className="mx-auto max-w-4xl px-4 lg:px-8">
      <div className="rounded-3xl border border-ink-200 bg-surface p-6 shadow-lg lg:p-10">
        <div className="mx-auto mb-8 max-w-xl text-center">
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-100 text-brand-600">
            <span aria-hidden className="text-2xl">🩸</span>
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight text-ink-900 lg:text-3xl">{d.title}</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-600 sm:text-sm">{d.subtitle}</p>
        </div>

        {signedIn && isDonor ? (
          <div className="grid gap-4 text-center">
            <p className="text-sm font-semibold text-emerald-700">{r.registeredPrompt}</p>
            <Link
              href="/profile"
              className="self-center rounded-xl bg-brand-500 px-6 py-3 text-sm font-bold text-white shadow-sm hover:bg-brand-600"
            >
              {r.profileCta}
            </Link>
          </div>
        ) : signedIn ? (
          <RegisterWizard dict={r} />
        ) : (
          <div className="mx-auto max-w-md">
            <SignUpForm
              next="/#donor-register"
              labels={{
                socialDivider: a.socialDivider,
                socialGoogle: a.socialGoogle,
                socialFacebook: a.socialFacebook,
                socialApple: a.socialApple,
              }}
            />
            <p className="mt-6 text-center text-xs text-ink-600">
              {d.haveAccount}{" "}
              <Link href="/login?next=/%23donor-register" className="font-semibold text-brand-600 underline hover:no-underline">
                {d.loginCta}
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
