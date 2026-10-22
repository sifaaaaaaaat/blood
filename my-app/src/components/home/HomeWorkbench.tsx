"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bloodGroups } from "@/src/lib/validation/donor";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

type WorkbenchDict = Dictionary["home"]["workbench"];
type RequestsDict = Dictionary["requests"];

type District = { id: number; name: string; nameBn: string };
type Upazila = District;

export type WorkbenchPrefill = {
  bloodGroup?: string;
  hospital?: string;
  divisionId?: number;
  districtId?: number;
  upazilaId?: number;
};

/**
 * Request workbench (homepage block): the campus-style direct-request form.
 * Posts to the REAL POST /api/requirements endpoint (same one as /requests/new).
 * Signed-out users are routed to /login?next=… for the account-gated submit —
 * the same policy applies server-side, so nothing is bypassed client-side.
 * A signed-in submit runs the create call here with the same response handling.
 */
export function HomeWorkbench({
  dict,
  prefill,
  signedIn,
}: {
  dict: Dictionary;
  prefill: WorkbenchPrefill;
  signedIn: boolean;
}) {
  const w = dict.home.workbench;
  const r = dict.requests;
  const router = useRouter();

  const [group, setGroup] = useState(prefill.bloodGroup ?? "");
  const [divisionId, setDivisionId] = useState<number | null>(prefill.divisionId ?? null);
  const [districtId, setDistrictId] = useState<number | null>(prefill.districtId ?? null);
  const [upazilaId, setUpazilaId] = useState<number | null>(prefill.upazilaId ?? null);
  const [hospital, setHospital] = useState(prefill.hospital ?? "");
  const [units, setUnits] = useState("1");
  const [urgency, setUrgency] = useState<"routine" | "urgent" | "critical">("routine");
  const [requiredBy, setRequiredBy] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [okTone, setOkTone] = useState(true);

  const [divisions, setDivisions] = useState<District[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [districtLoading, setDistrictLoading] = useState(false);
  const [upazilas, setUpazilas] = useState<Upazila[]>([]);

  const mountedRef = useRef(false);

  // List loads mirror LocationCascade: setState ONLY from async fetch
  // results (never synchronously in the effect body).
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    fetch("/api/locations")
      .then((res) => res.json() as Promise<{ ok: boolean; data: District[] }>)
      .then((j) => {
        if (j.ok) setDivisions(j.data ?? []);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (divisionId === null || !mountedRef.current) return;
    let alive = true;
    fetch(`/api/locations?division=${divisionId}`)
      .then((res) => res.json() as Promise<{ ok: boolean; data: District[] }>)
      .then((j) => {
        if (alive) {
          setDistricts(j.ok ? j.data : []);
          setDistrictLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setDistricts([]);
          setDistrictLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [divisionId]);

  useEffect(() => {
    if (districtId === null) return;
    let alive = true;
    fetch(`/api/locations?district=${districtId}`)
      .then((res) => res.json() as Promise<{ ok: boolean; data: Upazila[] }>)
      .then((j) => {
        if (alive) setUpazilas(j.ok ? j.data : []);
      })
      .catch(() => {
        if (alive) setUpazilas([]);
      });
    return () => {
      alive = false;
    };
  }, [districtId]);

  const [urgentSoon] = useState(
    () => new Date(Date.now() + 90 * 60_000).toISOString().slice(0, 16)
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!signedIn) {
      const q = new URLSearchParams();
      q.set("next", "/requests/new");
      if (group) q.set("bg", group);
      if (divisionId) q.set("division", String(divisionId));
      if (districtId) q.set("district", String(districtId));
      if (upazilaId) q.set("upazila", String(upazilaId));
      if (hospital.trim()) q.set("hospital", hospital.trim().slice(0, 120));
      router.push(`/login?${q}`);
      return;
    }
    if (!group || !hospital.trim() || !upazilaId || !requiredBy || !consent) {
      setOkTone(false);
      setMessage(r.errors.heading);
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          blood_group: group,
          hospital_name: hospital.trim(),
          location: { upazila_id: upazilaId },
          urgency,
          units_needed: Math.min(Math.max(Number(units) || 1, 1), 20),
          required_by: new Date(requiredBy).toISOString(),
          consent_confirmed: true,
          contact_pref: "in_app",
          idempotency_key: crypto.randomUUID(),
        }),
      });
      const j = (await res.json()) as { ok: boolean; data?: { id: string }; message?: string };
      if ((res.status === 201 || res.status === 200) && j.ok && j.data) {
        setOkTone(true);
        setMessage(r.createdBody);
        router.push(`/requests/${j.data.id}`);
        return;
      }
      setOkTone(false);
      setMessage(j.message ?? `request failed (${res.status})`);
    } catch {
      setOkTone(false);
      setMessage(r.errors.network);
    } finally {
      setSubmitting(false);
    }
  }

  const inputCls =
    "w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-brand-500";
  const labelCls = "mb-1.5 block text-xs font-semibold text-ink-600";

  return (
    <div className="mx-auto max-w-7xl px-4 lg:px-8">
      <div className="rounded-3xl border border-ink-200 bg-surface p-6 shadow-lg lg:p-10">
        <div className="max-w-3xl">
          <span className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand-100 px-3 py-1 text-xs font-bold text-brand-700">
            <span aria-hidden>⏱</span>{w.tag}
          </span>
          <h2 className="text-2xl font-extrabold tracking-tight text-ink-900 lg:text-3xl">{w.title}</h2>
          <p className="mt-2 text-xs leading-relaxed text-ink-600 sm:text-sm">{w.subtitle}</p>
        </div>

        <form onSubmit={submit} className="mt-8 grid gap-6 noValidate={false}">
          {/* Step 1: group + urgency */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-12">
            <div className="sm:col-span-7">
              <span className="mb-2.5 block text-xs font-bold uppercase tracking-wider text-ink-900">
                1. {w.groupLabel} <span className="text-brand-500">*</span>
              </span>
              <div className="grid grid-cols-8 gap-2">
                {bloodGroups.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGroup(g)}
                    aria-pressed={group === g}
                    className={`h-12 rounded-xl border text-base font-extrabold transition-colors ${
                      group === g
                        ? "border-brand-500 bg-brand-500 text-white shadow-sm"
                        : "border-ink-200 bg-canvas text-ink-900 hover:border-brand-300"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-5">
              <label className="mb-2.5 block text-xs font-bold uppercase tracking-wider text-ink-900" htmlFor="wb-urgency">
                {w.urgencyLabel} <span className="text-brand-500">*</span>
              </label>
              <select id="wb-urgency" className={inputCls} value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
                <option value="routine">{r.form.urgencyRoutine}</option>
                <option value="urgent">{r.form.urgencyUrgent}</option>
                <option value="critical">{r.form.urgencyCritical}</option>
              </select>
            </div>
          </div>

          {/* Step 2: geography + hospital + units + deadline */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className={labelCls} htmlFor="wb-division">{w.divisionLabel}</label>
              <select id="wb-division" required className={inputCls} value={divisionId ?? ""}
                onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setDivisionId(v); setDistrictId(null); setUpazilaId(null); }}>
                <option value="">{w.choose}</option>
                {divisions.map((d) => <option key={d.id} value={d.id}>{d.nameBn || d.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="wb-district">{w.districtLabel}</label>
              <select id="wb-district" required className={inputCls} value={districtId ?? ""} disabled={!districts.length}
                onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setDistrictId(v); setUpazilaId(null); }}>
                <option value="">{districtLoading ? w.loading : w.choose}</option>
                {districts.map((d) => <option key={d.id} value={d.id}>{d.nameBn || d.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="wb-upazila">{w.upazilaLabel}</label>
              <select id="wb-upazila" required className={inputCls} value={upazilaId ?? ""} disabled={!upazilas.length}
                onChange={(e) => setUpazilaId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{w.choose}</option>
                {upazilas.map((u) => <option key={u.id} value={u.id}>{u.nameBn || u.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="wb-hospital">{w.hospitalLabel}</label>
              <input id="wb-hospital" required maxLength={120} className={inputCls}
                placeholder={w.hospitalPlaceholder} value={hospital} onChange={(e) => setHospital(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="wb-units">{w.unitsLabel}</label>
              <select id="wb-units" className={inputCls} value={units} onChange={(e) => setUnits(e.target.value)}>
                <option value="1">1</option><option value="2">2</option><option value="3">3</option>
                <option value="4">4</option><option value="6">6</option><option value="8">8</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="wb-required">{w.requiredByLabel}</label>
              <input id="wb-required" type="datetime-local" required className={inputCls} value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} />
            </div>
          </div>

          {/* Consent + action */}
          <label className="flex items-start gap-2.5 pt-2 text-xs text-ink-700">
            <input required type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-ink-300 accent-red-600" />
            <span>{w.consentLabel}</span>
          </label>

          <div className="flex flex-col items-center justify-between gap-4 border-t border-ink-200 pt-4 sm:flex-row">
            <p className="flex items-center gap-2 text-xs text-ink-600">
              <span aria-hidden className="text-emerald-600">✓</span>{w.note}
            </p>
            <div className="flex w-full items-center gap-3 sm:w-auto">
              <button
                type="button"
                onClick={() => router.push("/requests/new")}
                className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-white px-4 text-xs font-bold text-brand-700 shadow-sm transition-colors ring-1 ring-brand-200 hover:bg-brand-50 sm:w-auto"
              >
                {w.fullFormCta}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-8 text-xs font-bold uppercase tracking-wider text-white shadow-md transition-all hover:bg-brand-600 active:scale-[0.98] disabled:opacity-60 sm:w-auto"
              >
                {submitting ? w.submitting : w.cta}
              </button>
            </div>
          </div>
        </form>

        {message ? (
          <div
            role="status"
            className={`mt-6 flex items-center gap-3 rounded-2xl border p-4 text-xs ${
              okTone ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-red-300 bg-red-50 text-red-700"
            }`}
          >
            <span aria-hidden>{okTone ? "✓" : "!"}</span>
            <span>{message}</span>
            {okTone ? null : <Link href="/requests/new" className="ml-auto font-bold underline">{w.fullFormCta}</Link>}
          </div>
        ) : null}
        <p className="mt-4 text-[11px] text-ink-400">{w.earliestNote.replace("{earliest}", requiredBy || urgentSoon)}</p>
      </div>
    </div>
  );
}
