"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Alert } from "@/src/components/ui/primitives";
import { bloodGroups } from "@/src/lib/validation/donor";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import { LocationCascade, type LocationValue } from "./LocationCascade";

type RegDict = Dictionary["register"];

const STEPS: (keyof RegDict["steps"])[] = ["account", "health", "location", "availability"];

// Same pattern the server normalizes; client copy only pre-screens input.
const BD_MOBILE = /^(?:\+?880|0)1[3-9]\d{8}$/;

/**
 * Four-step donor registration (Phase 11D), session-gated by the server page.
 * Each step blocks advancing until its fields are plausible; the server
 * schema remains the single source of truth — step 4 posts to
 * /api/donors/register and surfaces real server errors in context.
 */
export function RegisterWizard({ dict }: { dict: RegDict }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [bloodGroup, setBloodGroup] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [location, setLocation] = useState<LocationValue>({
    division_id: null,
    district_id: null,
    upazila_id: null,
  });
  const [lastDonation, setLastDonation] = useState("");
  const [consent, setConsent] = useState(false);
  const [channel, setChannel] = useState<"in_app" | "sms">("in_app");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const thisYear = new Date().getUTCFullYear();

  const stepError = useMemo((): string | null => {
    if (step === 0) {
      if (name.trim().length < 2) return dict.account.nameHelp; // reuse hints as reasons-to-fix
      if (!BD_MOBILE.test(phone.trim())) return dict.account.phoneHelp;
    }
    if (step === 1) {
      if (!bloodGroup) return dict.health.groupHelp;
      const y = Number(birthYear);
      if (!Number.isInteger(y) || y > thisYear - 16 || y < thisYear - 100) return dict.health.birthYearHelp;
    }
    if (step === 2) {
      if (!location.division_id || !location.district_id || !location.upazila_id) return dict.location.help;
    }
    return null;
  }, [step, name, phone, bloodGroup, birthYear, location, thisYear, dict]);

  async function submitFinal(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/donors/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: name.trim(),
          phone: phone.trim(),
          blood_group: bloodGroup,
          birth_year: Number(birthYear),
          location,
          availability: "available",
          last_donation_date: lastDonation ? lastDonation : undefined,
          notify_consent: consent,
          notify_channel: consent ? channel : "none",
        }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (res.status === 201 && json.ok) {
        setDone(true);
      } else {
        setError(json.message ?? `request failed (${res.status})`);
      }
    } catch {
      setError("network error — try again");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="grid gap-4 text-center">
        <Alert tone="success" title={dict.availability.successTitle}>
          <span>{dict.availability.successBody}</span>
        </Alert>
        <Link href="/profile" className="self-center text-sm font-semibold text-red-700 underline hover:no-underline">
          {dict.availability.profileCta}
        </Link>
      </div>
    );
  }

  const cascadeLabels = {
    ...dict.location,
    division: dict.location.divisionLabel,
    district: dict.location.districtLabel,
    upazila: dict.location.upazilaLabel,
  };

  return (
    <form
      onSubmit={(e) => {
        if (step < STEPS.length - 1) {
          e.preventDefault();
          setStep(step + 1);
        } else {
          void submitFinal(e);
        }
      }}
      className="grid gap-6"
      noValidate
    >
      {/* Step indicator */}
      <div>
        <p className="text-sm font-semibold text-ink-700">
          {dict.stepOf.replace("{n}", String(step + 1)).replace("{total}", String(STEPS.length))}{" "}
          · {dict.steps[STEPS[step]]}
        </p>
        <div className="mt-2 h-1.5 rounded-full bg-ink-100">
          <div
            className="h-1.5 rounded-full bg-red-600 transition-all"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      {step === 0 && (
        <fieldset className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="reg-name" className="text-sm font-semibold text-ink-800">
              {dict.account.nameLabel}
            </label>
            <input
              id="reg-name"
              className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={80}
            />
            <p className="text-sm text-ink-600">{dict.account.nameHelp}</p>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="reg-phone" className="text-sm font-semibold text-ink-800">
              {dict.account.phoneLabel}
            </label>
            <input
              id="reg-phone"
              className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
              placeholder={dict.account.phonePlaceholder}
            />
            <p className="text-sm text-ink-600">{dict.account.phoneHelp}</p>
          </div>
        </fieldset>
      )}

      {step === 1 && (
        <fieldset className="grid gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="reg-group" className="text-sm font-semibold text-ink-800">
              {dict.health.groupLabel}
            </label>
            <select
              id="reg-group"
              className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              value={bloodGroup}
              onChange={(e) => setBloodGroup(e.target.value)}
            >
              <option value="">—</option>
              {bloodGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <p className="text-sm text-ink-600">{dict.health.groupHelp}</p>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="reg-year" className="text-sm font-semibold text-ink-800">
              {dict.health.birthYearLabel}
            </label>
            <input
              id="reg-year"
              type="number"
              min={thisYear - 100}
              max={thisYear - 16}
              className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              value={birthYear}
              onChange={(e) => setBirthYear(e.target.value)}
            />
            <p className="text-sm text-ink-600">{dict.health.birthYearHelp}</p>
          </div>
        </fieldset>
      )}

      {step === 2 && <LocationCascade labels={cascadeLabels} value={location} onChange={setLocation} />}

      {step === 3 && (
        <fieldset className="grid gap-5">
          <p className="text-sm font-semibold text-ink-800">{dict.availability.availableLabel}</p>
          <div className="grid gap-1.5">
            <label htmlFor="reg-last" className="text-sm font-semibold text-ink-800">
              {dict.availability.lastDonationLabel}
            </label>
            <input
              id="reg-last"
              type="date"
              className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              max={new Date().toISOString().slice(0, 10)}
              value={lastDonation}
              onChange={(e) => setLastDonation(e.target.value)}
            />
            <p className="text-sm text-ink-600">{dict.availability.lastDonationHelp}</p>
          </div>
          <div className="rounded-lg border border-ink-200 bg-ink-50 p-4">
            <label htmlFor="reg-consent" className="flex items-start gap-3 text-sm font-semibold text-ink-800">
              <input
                id="reg-consent"
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-ink-300 accent-red-600"
              />
              <span>
                {dict.availability.consentLabel}
                <span className="mt-1 block text-sm font-normal text-ink-600">{dict.availability.consentHelp}</span>
              </span>
            </label>
            {consent && (
              <div className="mt-3 grid gap-2">
                <span className="text-sm font-semibold text-ink-800">{dict.availability.channelLabel}</span>
                {(
                  [
                    ["in_app", dict.availability.channelInApp],
                    ["sms", dict.availability.channelSms],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-3 text-sm text-ink-700">
                    <input
                      type="radio"
                      name="reg-channel"
                      checked={channel === v}
                      onChange={() => setChannel(v)}
                      className="h-4 w-4 accent-red-600"
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </fieldset>
      )}

      {error ? (
        <Alert tone="error" title={dict.availability.errorHeading}>
          <span>{error}</span>
        </Alert>
      ) : null}

      {/* Nav buttons: client-side plausibility gates each step; final submit
          happens through the form's onSubmit → submitFinal. */}
      <div className="flex items-center justify-between gap-3">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="inline-flex h-11 items-center rounded-lg px-4 text-sm font-semibold text-ink-700 hover:bg-ink-100"
          >
            {dict.prev}
          </button>
        ) : (
          <span />
        )}
        {step < STEPS.length - 1 ? (
          <button
            type="submit"
            disabled={stepError !== null}
            className="inline-flex h-11 items-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {dict.next}
          </button>
        ) : (
          <button
            type="submit"
            disabled={stepError !== null || submitting}
            className="inline-flex h-11 items-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {submitting ? dict.availability.submitting : dict.availability.submit}
          </button>
        )}
      </div>
    </form>
  );
}
