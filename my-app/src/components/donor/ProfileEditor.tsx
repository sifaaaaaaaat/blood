"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Card } from "@/src/components/ui/primitives";
import { bloodGroups, type DonorProfileResponse } from "@/src/lib/validation/donor";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import { LocationCascade, type LocationValue } from "./LocationCascade";

const initialLoc = (p: DonorProfileResponse): LocationValue => ({
  division_id: p.division_id,
  district_id: p.district_id,
  upazila_id: p.upazila_id,
});

/**
 * Donor profile management (Phase 11D): read-only view with edit mode,
 * pause/resume of availability, and sign-out. Every save goes through
 * PATCH /api/donors/me (owner-bound, server-validated); after a save the
 * component re-reads the owner's profile so the view always shows what the
 * database actually accepted.
 */
export function ProfileEditor({ initial, dict }: { initial: DonorProfileResponse; dict: Dictionary }) {
  const p = dict.profile;
  const router = useRouter();
  const [profile, setProfile] = useState<DonorProfileResponse>(initial);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Edit-mode field state (separate from the view so Cancel is honest).
  const [name, setName] = useState(initial.display_name);
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [group, setGroup] = useState<string>(initial.blood_group);
  const [birthYear, setBirthYear] = useState(String(initial.birth_year));
  const [lastDonation, setLastDonation] = useState(initial.last_donation_date ?? "");
  const [location, setLocation] = useState<LocationValue>(initialLoc(initial));

  // Pause card
  const [pauseDate, setPauseDate] = useState("");
  const [pauseWorking, setPauseWorking] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  // Sign-out
  const [signingOut, setSigningOut] = useState(false);

  const isPaused =
    profile.availability === "paused" ||
    (profile.paused_until !== null && new Date(profile.paused_until) > new Date());

  async function refetch() {
    const res = await fetch("/api/donors/me", { cache: "no-store" });
    const json = (await res.json()) as { ok: boolean; data?: DonorProfileResponse };
    if (res.ok && json.ok && json.data) setProfile(json.data);
  }

  async function openEdit() {
    // Seed edit fields from the CURRENT profile, not stale mount state.
    setName(profile.display_name);
    setPhone(profile.phone ?? "");
    setGroup(profile.blood_group);
    setBirthYear(String(profile.birth_year));
    setLastDonation(profile.last_donation_date ?? "");
    setLocation(initialLoc(profile));
    setError(null);
    setSaved(false);
    setEditing(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {
        display_name: name.trim(),
        blood_group: group,
        birth_year: Number(birthYear),
        location,
      };
      if (phone.trim() && phone.trim() !== profile.phone) patch.phone = phone.trim();
      if (lastDonation) patch.last_donation_date = lastDonation;
      else if (profile.last_donation_date) patch.last_donation_date = null;

      const res = await fetch("/api/donors/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (res.ok && json.ok) {
        await refetch();
        setEditing(false);
        setSaved(true);
      } else {
        setError(json.message ?? `update failed (${res.status})`);
      }
    } catch {
      setError("network error — try again");
    } finally {
      setSaving(false);
    }
  }

  async function setPaused(paused: boolean, until?: string) {
    setPauseWorking(true);
    setPauseError(null);
    try {
      const body = paused ? { availability: "paused", paused_until: until } : { availability: "available" };
      const res = await fetch("/api/donors/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (res.ok && json.ok) {
        await refetch();
      } else {
        setPauseError(json.message ?? `update failed (${res.status})`);
      }
    } catch {
      setPauseError("network error — try again");
    } finally {
      setPauseWorking(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/signout", { method: "POST" });
    } catch {
      // fall through: navigation below lands signed-out either way.
    }
    // push + refresh re-renders the RSC tree with the cleared session.
    router.push("/");
    router.refresh();
  }

  const view = "text-[15px] text-ink-800";
  const cascadeLabels = {
    ...dict.register.location,
    division: p.editLabels.division,
    district: p.editLabels.district,
    upazila: p.editLabels.upazila,
  };
  const thisYear = new Date().getUTCFullYear();

  return (
    <div className="grid gap-6">
      <Card className="p-6 sm:p-8">
        {saved ? <p className="mb-4 text-sm font-semibold text-teal-600">{p.saved}</p> : null}

        {editing ? (
          <form onSubmit={save} className="grid gap-5" noValidate>
            <div className="grid gap-1.5">
              <label htmlFor="pf-name" className="text-sm font-semibold text-ink-800">
                {p.editLabels.name}
              </label>
              <input
                id="pf-name"
                className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="pf-phone" className="text-sm font-semibold text-ink-800">
                {p.editLabels.phone}
              </label>
              <input
                id="pf-phone"
                className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
              />
              <p className="text-sm text-ink-600">{p.phoneHelp}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <label htmlFor="pf-group" className="text-sm font-semibold text-ink-800">
                  {p.editLabels.group}
                </label>
                <select
                  id="pf-group"
                  className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px]"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  {bloodGroups.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="pf-year" className="text-sm font-semibold text-ink-800">
                  {p.editLabels.birthYear}
                </label>
                <input
                  id="pf-year"
                  type="number"
                  min={thisYear - 100}
                  max={thisYear - 16}
                  className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px]"
                  value={birthYear}
                  onChange={(e) => setBirthYear(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="pf-last" className="text-sm font-semibold text-ink-800">
                {p.editLabels.lastDonation}
              </label>
              <input
                id="pf-last"
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px]"
                value={lastDonation}
                onChange={(e) => setLastDonation(e.target.value)}
              />
            </div>
            <LocationCascade labels={cascadeLabels} value={location} onChange={setLocation} />

            {error ? (
              <Alert tone="error" title={p.errorHeading}>
                <span>{error}</span>
              </Alert>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-11 items-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
              >
                {saving ? p.saving : p.saveCta}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex h-11 items-center rounded-lg px-4 text-sm font-semibold text-ink-700 hover:bg-ink-100"
              >
                {p.cancelCta}
              </button>
            </div>
          </form>
        ) : (
          <div className="grid gap-4">
            <Row label={p.nameLabel}>
              <span className={view}>{profile.display_name}</span>
            </Row>
            <Row label={p.phoneLabel}>
              <span className={view}>{profile.phone ?? p.locationMissing}</span>
              <Badge tone={profile.is_phone_verified ? "brand" : "neutral"}>
                {profile.is_phone_verified ? p.phoneVerified : p.phoneUnverified}
              </Badge>
            </Row>
            <Row label={p.bloodGroupLabel}>
              <span className={`font-semibold ${view}`}>{profile.blood_group}</span>
            </Row>
            <Row label={p.birthYearLabel}>
              <span className={view}>{profile.birth_year}</span>
            </Row>
            <Row label={p.locationLabel}>
              <span className={view}>
                {profile.division_id && profile.district_id && profile.upazila_id
                  ? `#${profile.district_id} · #${profile.upazila_id}`
                  : p.locationMissing}
              </span>
            </Row>
            <Row label={p.availabilityLabel}>
              <Badge tone={isPaused ? "warning" : "brand"}>{isPaused ? p.paused : p.available}</Badge>
            </Row>
            <Row label={p.lastDonationLabel}>
              <span className={view}>{profile.last_donation_date ?? p.lastDonationNone}</span>
            </Row>
            <Row label={p.consentLabel}>
              <span className={view}>
                {profile.notify_consent ? p.consentOn : p.consentOff}
                {profile.notify_channel !== "none" ? ` · ${p.channelLabel}: ${p.channels[profile.notify_channel]}` : ""}
              </span>
            </Row>

            <div className="mt-2">
              <button
                type="button"
                onClick={openEdit}
                className="inline-flex h-11 items-center rounded-lg border border-red-200 bg-white px-5 text-sm font-semibold text-red-700 hover:bg-red-50"
              >
                {p.editCta}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="text-lg font-bold text-ink-900">{p.pauseTitle}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">{p.pauseHelp}</p>
        {isPaused ? (
          <div className="mt-4 grid gap-3">
            <p className="text-sm font-semibold text-amber-warm-600">
              {p.pauseActive.replace("{date}", profile.paused_until ? profile.paused_until.slice(0, 10) : "—")}
            </p>
            <button
              type="button"
              disabled={pauseWorking}
              onClick={() => setPaused(false)}
              className="inline-flex h-11 w-fit items-center rounded-lg bg-red-600 px-5 font-semibold text-white hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
            >
              {pauseWorking ? p.pauseWorking : p.pauseClear}
            </button>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr] sm:items-end">
            <div className="grid gap-1.5">
              <label htmlFor="pf-pause" className="text-sm font-semibold text-ink-800">
                {p.pauseUntilLabel}
              </label>
              <input
                id="pf-pause"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px]"
                value={pauseDate}
                onChange={(e) => setPauseDate(e.target.value)}
              />
            </div>
            <button
              type="button"
              disabled={pauseWorking || !pauseDate}
              onClick={() => setPaused(true, pauseDate)}
              className="inline-flex h-11 w-fit items-center rounded-lg border border-red-200 bg-white px-5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:pointer-events-none disabled:opacity-60"
            >
              {pauseWorking ? p.pauseWorking : p.pauseSet}
            </button>
          </div>
        )}
        {pauseError ? (
          <div className="mt-3">
            <Alert tone="error" title={p.errorHeading}>
              <span>{pauseError}</span>
            </Alert>
          </div>
        ) : null}
      </Card>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold text-ink-600 hover:bg-ink-100 disabled:opacity-60"
        >
          {signingOut ? p.signOutGoing : p.signOut}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ink-100 pb-3 last:border-b-0">
      <dt className="w-40 shrink-0 text-sm font-semibold text-ink-500">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}
