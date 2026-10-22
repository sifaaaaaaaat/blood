"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/src/components/ui/primitives";
import { BANK_KINDS } from "@/src/lib/validation/directory";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import { LocationCascade, type LocationValue } from "./LocationCascade";

/**
 * Blood-bank proposal form (signed-in users). Posts to
 * /api/blood-banks/propose; the submission is stored unpublished and appears
 * in thedirectory only after a moderator verifies it.
 */
export function BankProposalForm({ dict }: { dict: Dictionary }) {
  const p = dict.directory.propose;
  const [name, setName] = useState("");
  const [nameBn, setNameBn] = useState("");
  const [kind, setKind] = useState<string>("hospital_bank");
  const [location, setLocation] = useState<LocationValue>({ division_id: null, district_id: null, upazila_id: null });
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [hours, setHours] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState(false);

  const cascadeLabels = {
    ...dict.register.location,
    division: p.divisionLabel,
    district: p.districtLabel,
    upazila: p.upazilaLabel,
  };
  const input =
    "h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 w-full";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const missing: string[] = [];
    if (name.trim().length < 2) missing.push(p.nameLabel);
    if (!location.division_id || !location.district_id) missing.push(`${p.divisionLabel} / ${p.districtLabel}`);
    if (address.trim().length < 5) missing.push(p.addressLabel);
    if (sourceNote.trim().length < 4) missing.push(p.sourceNoteLabel);
    if (missing.length > 0) {
      setError(`${p.missingFieldsLead} ${missing.join(" · ")}`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/blood-banks/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          nameBn: nameBn.trim() || undefined,
          kind,
          divisionId: location.division_id,
          districtId: location.district_id,
          upazilaId: location.upazila_id ?? undefined,
          address: address.trim(),
          phone: phone.trim() || undefined,
          openingHours: hours.trim() || undefined,
          sourceNote: sourceNote.trim(),
        }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (res.status === 201 && json.ok) {
        setReceived(true);
      } else {
        setError(json.message ?? `submission failed (${res.status})`);
      }
    } catch {
      setError(dict.requests.errors.network);
    } finally {
      setSubmitting(false);
    }
  }

  if (received) {
    return (
      <div className="grid gap-4 text-center">
        <Alert tone="success" title={p.successTitle}>
          <span>{p.successBody}</span>
        </Alert>
        <Link href="/directory" className="self-center text-sm font-semibold text-red-700 underline hover:no-underline">
          {p.backToDirectory}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <div className="grid gap-1.5">
        <label htmlFor="bp-name" className="text-sm font-semibold text-ink-800">
          {p.nameLabel}
        </label>
        <input id="bp-name" required maxLength={150} className={input} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="bp-name-bn" className="text-sm font-semibold text-ink-800">
          {p.nameBnLabel}
        </label>
        <input id="bp-name-bn" maxLength={150} className={input} value={nameBn} onChange={(e) => setNameBn(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="bp-kind" className="text-sm font-semibold text-ink-800">
          {p.kindLabel}
        </label>
        <select id="bp-kind" className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
          {BANK_KINDS.map((k) => (
            <option key={k} value={k}>
              {dict.directory.kinds[k]}
            </option>
          ))}
        </select>
      </div>
      <LocationCascade labels={cascadeLabels} value={location} onChange={setLocation} />
      <div className="grid gap-1.5">
        <label htmlFor="bp-address" className="text-sm font-semibold text-ink-800">
          {p.addressLabel}
        </label>
        <input id="bp-address" required maxLength={300} placeholder="..." className={input} value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <label htmlFor="bp-phone" className="text-sm font-semibold text-ink-800">
            {p.phoneLabel}
          </label>
          <input id="bp-phone" maxLength={16} placeholder="01XXXXXXXXX" className={input} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="bp-hours" className="text-sm font-semibold text-ink-800">
            {p.hoursLabel}
          </label>
          <input id="bp-hours" maxLength={200} className={input} value={hours} onChange={(e) => setHours(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="bp-source" className="text-sm font-semibold text-ink-800">
          {p.sourceNoteLabel}
        </label>
        <textarea
          id="bp-source"
          required
          maxLength={240}
          rows={2}
          placeholder={p.sourceNotePlaceholder}
          className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
          value={sourceNote}
          onChange={(e) => setSourceNote(e.target.value)}
        />
      </div>

      {error ? (
        <Alert tone="error" title={dict.requests.errors.heading}>
          <span>{error}</span>
        </Alert>
      ) : null}
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
      >
        {submitting ? p.submitting : p.submit}
      </button>
      {dict.directory.addBankNote ? <p className="text-xs text-ink-500">{dict.directory.addBankNote}</p> : null}
    </form>
  );
}
