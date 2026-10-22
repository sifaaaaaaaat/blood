"use client";

import { useEffect, useState } from "react";

export type LocationValue = {
  division_id: number | null;
  district_id: number | null;
  upazila_id: number | null;
};

type Option = { id: number; name: string; nameBn: string };

type Labels = {
  division: string;
  district: string;
  upazila: string;
  choose: string;
  loading: string;
  help: string;
};

/**
 * Division → district → upazila cascade (Phase 11D), backed by the public
 * /api/locations endpoint over the platform's own Phase 4 seed. Used by both
 * the register wizard and the profile editor.
 *
 * All list updates happen asynchronously from fetch results — effects never
 * call setState synchronously. Changing a parent resets the child values in
 * the onChange handlers (user events), so an invalid combination can never
 * be submitted.
 */
export function LocationCascade({
  labels,
  value,
  onChange,
}: {
  labels: Labels;
  value: LocationValue;
  onChange: (v: LocationValue) => void;
}) {
  const [divisions, setDivisions] = useState<Option[]>([]);
  const [districts, setDistricts] = useState<Option[]>([]);
  const [upazilas, setUpazilas] = useState<Option[]>([]);

  // Divisions load once on mount.
  useEffect(() => {
    let alive = true;
    fetch("/api/locations")
      .then((r) => r.json())
      .then((j: { ok: boolean; data?: Option[] }) => {
        if (alive && j.ok) setDivisions(j.data ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Districts load for the selected division. The list is only fetched for
  // the CURRENT division; when the parent changes the children are reset in
  // the select's onChange, so a stale list is never selectable.
  useEffect(() => {
    if (!value.division_id) return;
    let alive = true;
    fetch(`/api/locations?division=${value.division_id}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; data?: Option[] }) => {
        if (alive && j.ok) setDistricts(j.data ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [value.division_id]);

  useEffect(() => {
    if (!value.district_id) return;
    let alive = true;
    fetch(`/api/locations?district=${value.district_id}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; data?: Option[] }) => {
        if (alive && j.ok) setUpazilas(j.data ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [value.district_id]);

  const cls =
    "h-11 w-full rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 disabled:bg-ink-100";
  const loading =
    divisions.length === 0 ||
    (value.division_id !== null && districts.length === 0) ||
    (value.district_id !== null && upazilas.length === 0);

  return (
    <div className="grid gap-4" data-testid="location-cascade">
      <div className="grid gap-1.5">
        <label htmlFor="division" className="text-sm font-semibold text-ink-800">
          {labels.division}
        </label>
        <select
          id="division"
          className={cls}
          disabled={divisions.length === 0}
          value={value.division_id ?? ""}
          onChange={(e) =>
            onChange({
              division_id: e.target.value ? Number(e.target.value) : null,
              district_id: null,
              upazila_id: null,
            })
          }
        >
          <option value="">{labels.choose}</option>
          {divisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="district" className="text-sm font-semibold text-ink-800">
          {labels.district}
        </label>
        <select
          id="district"
          className={cls}
          disabled={!value.division_id}
          value={value.district_id ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              district_id: e.target.value ? Number(e.target.value) : null,
              upazila_id: null,
            })
          }
        >
          <option value="">{labels.choose}</option>
          {districts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="upazila" className="text-sm font-semibold text-ink-800">
          {labels.upazila}
        </label>
        <select
          id="upazila"
          className={cls}
          disabled={!value.district_id}
          value={value.upazila_id ?? ""}
          onChange={(e) => onChange({ ...value, upazila_id: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">{labels.choose}</option>
          {upazilas.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      <p className="text-sm leading-relaxed text-ink-600">{labels.help}</p>
      {loading ? <span className="text-xs text-ink-500">{labels.loading}</span> : null}
    </div>
  );
}
