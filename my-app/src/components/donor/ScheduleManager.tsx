"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, Card, EmptyState } from "@/src/components/ui/primitives";
import { LocationCascade, type LocationValue } from "./LocationCascade";

/**
 * Recurring-schedule management (Phase 11J). Purely a client over the owner
 * -scoped /api/recurring endpoints; every rule (consent literal, ownership,
 * due-date gating) is enforced server-side — this UI only reflects state.
 */
type ScheduleRow = {
  id: string;
  patient_label: string;
  blood_group: string;
  hospital_name: string;
  location_text: string | null;
  units_needed: number;
  interval_days: number;
  active: boolean;
  next_due_at: string;
  last_request_id: string | null;
};
type Schedule = ScheduleRow & { due: boolean };

type ThalDict = {
  listTitle: string;
  listEmpty: string;
  formTitle: string;
  form: {
    patientLabel: string;
    patientPlaceholder: string;
    groupLabel: string;
    hospitalLabel: string;
    locationLabel: string;
    unitsLabel: string;
    intervalLabel: string;
    contactPrefLabel: string;
    consentLabel: string;
    submit: string;
    creating: string;
  };
  item: {
    units: string;
    everyDays: string;
    active: string;
    paused: string;
    lastRequest: string;
    lastNone: string;
    nextDue: string;
    dueNote: string;
    pauseCta: string;
    resumeCta: string;
    deleteCta: string;
    regenerateCta: string;
    working: string;
    draftCreated: string;
    notDue: string;
  };
  errors: { heading: string };
};

const input =
  "h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 w-full";

export function ScheduleManager({
  dict,
  cascadeLabels,
}: {
  dict: ThalDict;
  cascadeLabels: { division: string; district: string; upazila: string };
}) {
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/recurring", { headers: { accept: "application/json" } });
      const json = (await res.json()) as { ok: boolean; data?: ScheduleRow[]; message?: string };
      if (res.status === 401) {
        router.push("/login?next=/thalassemia");
        return;
      }
      if (json.ok) {
        // The due flag is computed at refresh time (clock read out of the
        // render path), not on every render.
        setSchedules(withDue(json.data ?? []));
      } else {
        setError(json.message ?? `loading failed (${res.status})`);
      }
    } catch {
      setError("network");
    }
  }

  useEffect(() => {
    let alive = true;
    fetch("/api/recurring", { headers: { accept: "application/json" } })
      .then(async (res) => {
        const json = (await res.json()) as { ok: boolean; data?: ScheduleRow[]; message?: string };
        if (!alive) return;
        if (res.status === 401) {
          router.push("/login?next=/thalassemia");
          return;
        }
        if (json.ok) {
          setSchedules(withDue(json.data ?? []));
        } else {
          setError(json.message ?? `loading failed (${res.status})`);
        }
      })
      .catch(() => {
        if (alive) setError("network");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(id: string, run: () => Promise<Response>, onDone?: (data: { requestId?: string | null; due?: boolean }) => void) {
    setBusyId(id);
    setError(null);
    setFlash(null);
    try {
      const res = await run();
      const json = (await res.json()) as { ok: boolean; message?: string; data?: { requestId?: string | null; due?: boolean } };
      if (json.ok) {
        onDone?.(json.data ?? {});
        await load();
        router.refresh();
      } else {
        setError(json.message ?? `request failed (${res.status})`);
      }
    } catch {
      setError("network");
    } finally {
      setBusyId(null);
    }
  }

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const upazila = Number(data.get("upazila_id"));
    if (!upazila) {
      setError(cascadeLabels.upazila);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/recurring", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          patient_label: String(data.get("patient_label") ?? "").trim(),
          blood_group: String(data.get("blood_group") ?? ""),
          hospital_name: String(data.get("hospital_name") ?? "").trim(),
          location: { upazila_id: upazila },
          units_needed: Number(data.get("units_needed")),
          interval_days: Number(data.get("interval_days")),
          contact_pref: String(data.get("contact_pref") || "in_app"),
          consent_confirmed: data.get("consent") === "on",
        }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (json.ok) {
        form.reset();
        setShowForm(false);
        await load();
        router.refresh();
      } else {
        setError(json.message ?? `request failed (${res.status})`);
      }
    } catch {
      setError("network");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid gap-6">
      <h2 className="text-lg font-semibold text-ink-900">{dict.listTitle}</h2>

      {error ? (
        <Alert tone="error" title={dict.errors.heading}>
          <span>{error}</span>
        </Alert>
      ) : null}
      {flash ? (
        <div role="status">
          <Alert tone="success" title={flash} />
        </div>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex h-11 items-center justify-center rounded-lg bg-white px-4 font-semibold text-red-700 border border-red-200 shadow-sm transition-colors hover:bg-red-50"
        >
          {showForm ? dict.formTitle : dict.form.submit}
        </button>
      </div>

      {showForm ? (
        <Card className="p-6">
          <p className="mb-5 text-sm font-semibold text-ink-800">{dict.formTitle}</p>
          <ScheduleForm dict={dict} cascadeLabels={cascadeLabels} creating={creating} onSubmit={onCreate} />
        </Card>
      ) : null}

      {schedules === null ? (
        <div className="text-sm text-ink-500">…</div>
      ) : schedules.length === 0 ? (
        <EmptyState message={dict.listEmpty} />
      ) : (
        <ul className="grid gap-3">
          {schedules.map((s) => {
            const due = s.due;
            return (
              <li key={s.id}>
                <ScheduleRow
                  dict={dict}
                  schedule={s}
                  due={due}
                  busy={busyId === s.id}
                  onPause={() =>
                    act(s.id, () => req("PATCH", `/api/recurring/${s.id}`, { active: false }))
                  }
                  onResume={() =>
                    act(s.id, () => req("PATCH", `/api/recurring/${s.id}`, { active: true }))
                  }
                  onDelete={() =>
                    act(s.id, () => req("DELETE", `/api/recurring/${s.id}`))
                  }
                  onMaterialize={() =>
                    act(
                      s.id,
                      () => req("POST", `/api/recurring/${s.id}/materialize`),
                      (d) =>
                        setFlash(
                          d.due ? (d.requestId ? dict.item.draftCreated : null) : dict.item.notDue
                        )
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ScheduleRow({
  dict,
  schedule: s,
  due,
  busy,
  onPause,
  onResume,
  onDelete,
  onMaterialize,
}: {
  dict: ThalDict;
  schedule: Schedule;
  due: boolean;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onMaterialize: () => void;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
          s.active ? "bg-red-100 text-red-700" : "bg-ink-100 text-ink-500"
        }`}
      >
        {s.active ? dict.item.active : dict.item.paused}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-ink-900">
          {s.blood_group} · {s.patient_label || s.hospital_name}
        </p>
        <p className="text-sm text-ink-600">
          {s.hospital_name}
          {s.location_text ? ` · ${s.location_text}` : ""} · {dict.item.units} {s.units_needed} ·{" "}
          {dict.item.everyDays.replace("{n}", String(s.interval_days))}
        </p>
        <p className="text-sm text-ink-600">
          {dict.item.nextDue}: {new Date(s.next_due_at).toLocaleString()}
          {due ? <span className="font-semibold text-red-700"> — {dict.item.dueNote}</span> : null}
        </p>
        <p className="text-sm text-ink-500">
          {dict.item.lastRequest}:{" "}
          {s.last_request_id ? (
            <Link href={`/requests/${s.last_request_id}`} className="font-semibold text-red-700 underline hover:no-underline">
              {s.last_request_id.slice(0, 8)}…
            </Link>
          ) : (
            dict.item.lastNone
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <SmallBtn label={dict.item.regenerateCta} onClick={onMaterialize} disabled={busy} />
        {s.active ? (
          <SmallBtn label={dict.item.pauseCta} onClick={onPause} disabled={busy} />
        ) : (
          <SmallBtn label={dict.item.resumeCta} onClick={onResume} disabled={busy} />
        )}
        <SmallBtn label={dict.item.deleteCta} onClick={onDelete} disabled={busy} />
      </div>
    </Card>
  );
}

function ScheduleForm({
  dict,
  cascadeLabels,
  creating,
  onSubmit,
}: {
  dict: ThalDict;
  cascadeLabels: { division: string; district: string; upazila: string };
  creating: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [location, setLocation] = useState<LocationValue>({ division_id: null, district_id: null, upazila_id: null });
  const labels = {
    division: cascadeLabels.division,
    district: cascadeLabels.district,
    upazila: cascadeLabels.upazila,
    choose: "—",
    loading: "…",
    help: "",
  };
  const bloodGroups = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"] as const;
  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <div className="grid gap-1.5">
        <label htmlFor="rc-patient" className="text-sm font-semibold text-ink-800">
          {dict.form.patientLabel}
        </label>
        <input id="rc-patient" name="patient_label" maxLength={80} placeholder={dict.form.patientPlaceholder} className={input} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="rc-group" className="text-sm font-semibold text-ink-800">
          {dict.form.groupLabel}
        </label>
        <select id="rc-group" name="blood_group" required className={input} defaultValue="">
          <option value="" disabled>—</option>
          {bloodGroups.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="rc-hospital" className="text-sm font-semibold text-ink-800">
          {dict.form.hospitalLabel}
        </label>
        <input id="rc-hospital" name="hospital_name" required maxLength={120} className={input} />
      </div>
      <input type="hidden" name="upazila_id" value={location.upazila_id ?? ""} />
      <LocationCascade labels={labels} value={location} onChange={setLocation} />
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <label htmlFor="rc-units" className="text-sm font-semibold text-ink-800">
            {dict.form.unitsLabel}
          </label>
          <input id="rc-units" name="units_needed" type="number" min={1} max={20} required defaultValue="1" className={input} />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="rc-interval" className="text-sm font-semibold text-ink-800">
            {dict.form.intervalLabel}
          </label>
          <input id="rc-interval" name="interval_days" type="number" min={1} max={365} required defaultValue="14" className={input} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="rc-pref" className="text-sm font-semibold text-ink-800">
          {dict.form.contactPrefLabel}
        </label>
        <select id="rc-pref" name="contact_pref" className={input} defaultValue="in_app">
          <option value="in_app">In-app</option>
          <option value="sms">SMS</option>
          <option value="phone_call">Phone</option>
        </select>
      </div>
      <label htmlFor="rc-consent" className="flex items-start gap-3 text-sm font-semibold text-ink-800">
        <input id="rc-consent" name="consent" type="checkbox" required className="mt-0.5 h-4 w-4 accent-red-600" />
        {dict.form.consentLabel}
      </label>
      <button
        type="submit"
        disabled={creating}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
      >
        {creating ? dict.form.creating : dict.form.submit}
      </button>
    </form>
  );
}

/** Module-level helper: the clock is read here (outside any render). */
function withDue(rows: ScheduleRow[]): Schedule[] {
  const now = Date.now();
  return rows.map((s) => ({
    ...s,
    due: s.active && new Date(s.next_due_at).getTime() <= now,
  }));
}

function req(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function SmallBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-60"
    >
      {label}
    </button>
  );
}
