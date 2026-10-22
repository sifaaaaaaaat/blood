"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/src/components/ui/primitives";
import { bloodGroups } from "@/src/lib/validation/donor";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import { LocationCascade, type LocationValue } from "./LocationCascade";

/**
 * Blood-request submission (Phase 11E). Posts the validated payload to
 * POST /api/requests; the server schema (consent literal, future required_by,
 * per-account daily caps, idempotent insert) stays authoritative.
 */
export function RequestForm({ dict }: { dict: Dictionary }) {
  const r = dict.requests;
  const f = r.form;
  const router = useRouter();

  const [bloodGroup, setBloodGroup] = useState("");
  const [hospital, setHospital] = useState("");
  const [location, setLocation] = useState<LocationValue>({ division_id: null, district_id: null, upazila_id: null });
  const [urgency, setUrgency] = useState<"routine" | "urgent" | "critical">("routine");
  const [units, setUnits] = useState("1");
  // Date and time are separate inputs: a datetime-local control stays EMPTY
  // when only the date is picked (time placeholder unfilled), which made the
  // submit button silently disabled — the "button does not work" bug.
  const [requiredByDate, setRequiredByDate] = useState("");
  const [requiredByTime, setRequiredByTime] = useState("10:00");
  const [notes, setNotes] = useState("");
  const [contactPref, setContactPref] = useState<"in_app" | "sms" | "phone_call">("in_app");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side gate: always explain WHAT is missing instead of letting a
    // disabled button sit there with no feedback.
    const requiredByIso =
      requiredByDate ? new Date(`${requiredByDate}T${requiredByTime || "10:00"}`).toISOString() : "";
    const missing: string[] = [];
    if (!bloodGroup) missing.push(f.groupLabel);
    if (hospital.trim().length < 2) missing.push(f.hospitalLabel);
    if (!location.upazila_id) missing.push(f.locationLabel);
    if (!requiredByDate) missing.push(f.requiredByMissing);
    else if (!Number.isNaN(Date.parse(requiredByIso)) && Date.parse(requiredByIso) <= Date.now() + 60_000)
      missing.push(f.requiredByPast);
    if (!consent) missing.push(f.consentLabel);
    if (missing.length > 0) {
      setError(`${f.missingFieldsLead} ${missing.join(" · ")}`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blood_group: bloodGroup,
          hospital_name: hospital,
          location: { upazila_id: location.upazila_id },
          urgency,
          units_needed: Number(units),
          required_by: requiredByIso,
          request_notes: notes || undefined,
          consent_confirmed: true,
          contact_pref: contactPref,
          idempotency_key: crypto.randomUUID(),
        }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string; data?: { id: string } };
      if ((res.status === 201 || res.status === 200) && json.ok && json.data) {
        setCreatedId(json.data.id);
      } else {
        setError(json.message ?? `request failed (${res.status})`);
      }
    } catch {
      setError(r.errors.network);
    } finally {
      setSubmitting(false);
    }
  }

  if (createdId) {
    return (
      <div className="grid gap-4 text-center">
        <Alert tone="success" title={r.createdTitle}>
          <span>{r.createdBody}</span>
        </Alert>
        <button
          type="button"
          onClick={() => router.push(`/requests/${createdId}`)}
          className="self-center text-sm font-semibold text-red-700 underline hover:no-underline"
        >
          {r.viewRequest}
        </button>
      </div>
    );
  }

  const cascadeLabels = {
    ...dict.register.location,
    division: r.form.locationLabel,
    district: dict.register.location.districtLabel,
    upazila: dict.register.location.upazilaLabel,
  };
  const input =
    "h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 w-full";

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <div className="grid gap-1.5">
        <label htmlFor="rq-group" className="text-sm font-semibold text-ink-800">
          {f.groupLabel}
        </label>
        <select id="rq-group" required className={input} value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)}>
          <option value="">—</option>
          {bloodGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="rq-hospital" className="text-sm font-semibold text-ink-800">
          {f.hospitalLabel}
        </label>
        <input
          id="rq-hospital"
          required
          maxLength={120}
          placeholder={f.hospitalPlaceholder}
          className={input}
          value={hospital}
          onChange={(e) => setHospital(e.target.value)}
        />
      </div>
      <LocationCascade labels={cascadeLabels} value={location} onChange={setLocation} />
      <div className="grid gap-1.5">
        <label className="text-sm font-semibold text-ink-800" htmlFor="rq-urgency">
          {f.urgencyLabel}
        </label>
        <select id="rq-urgency" className={input} value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
          <option value="routine">{f.urgencyRoutine}</option>
          <option value="urgent">{f.urgencyUrgent}</option>
          <option value="critical">{f.urgencyCritical}</option>
        </select>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="rq-units" className="text-sm font-semibold text-ink-800">
          {f.unitsLabel}
        </label>
        <input
          id="rq-units"
          type="number"
          min={1}
          max={20}
          required
          className={input}
          value={units}
          onChange={(e) => setUnits(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <label htmlFor="rq-required" className="text-sm font-semibold text-ink-800">
            {f.requiredByLabel}
          </label>
          <input
            id="rq-required"
            type="date"
            required
            className={input}
            value={requiredByDate}
            onChange={(e) => setRequiredByDate(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="rq-required-time" className="text-sm font-semibold text-ink-800">
            {f.requiredByTimeLabel}
          </label>
          <input
            id="rq-required-time"
            type="time"
            className={input}
            value={requiredByTime}
            onChange={(e) => setRequiredByTime(e.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="rq-notes" className="text-sm font-semibold text-ink-800">
          {f.notesLabel}
        </label>
        <textarea id="rq-notes" maxLength={500} rows={3} className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={f.notesPlaceholder} />
      </div>
      <div className="grid gap-1.5">
        <span className="text-sm font-semibold text-ink-800">{f.contactPrefLabel}</span>
        {(
          [
            ["in_app", f.contactInApp],
            ["sms", f.contactSms],
            ["phone_call", f.contactPhone],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="flex items-center gap-3 text-sm text-ink-700">
            <input type="radio" name="rq-contact" checked={contactPref === v} onChange={() => setContactPref(v)} className="h-4 w-4 accent-red-600" />
            {label}
          </label>
        ))}
      </div>
      <label className="flex items-start gap-3 text-sm font-semibold text-ink-800">
        <input id="rq-consent" type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-red-600" />
        {f.consentLabel}
      </label>

      {error ? (
        <Alert tone="error" title={r.errors.heading}>
          <span>{error}</span>
        </Alert>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
      >
        {submitting ? f.submitting : f.submit}
      </button>
    </form>
  );
}
