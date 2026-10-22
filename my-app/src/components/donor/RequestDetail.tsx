"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Badge, Card } from "@/src/components/ui/primitives";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

type Row = Record<string, unknown>;
type CandRow = { donor_user_id: string; display_name: string; blood_group: string; upazila_name: string; district_name: string; tier: number };

/**
 * Request detail and lifecycle controls (Phase 11E). Every action posts to
 * the server-authoritative endpoints: transitions (state machine), matches
 * (candidates → matches → notifications), and contact reveal (accept-gated).
 * The client never decides state — it only reflects what the server returns.
 */
export function RequestDetail({
  dict,
  request,
  matches,
  history,
}: {
  dict: Dictionary;
  request: Row;
  matches: Row[];
  history: Row[];
}) {
  const r = dict.requests;
  const d = r.detail;
  const id = String(request.id);
  const status = String(request.status);
  const active = ["draft", "submitted", "searching", "awaiting_responses"].includes(status);

  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState(status);
  const [revealed, setRevealed] = useState<Record<string, { phone: string } | "error">>({});
  const [candidates, setCandidates] = useState<CandRow[] | null>(null);

  const live = ["submitted", "searching", "awaiting_responses", "draft"].includes(currentStatus);

  // Live candidate pool (anonymized, server-side SQL). Names + area only.
  useEffect(() => {
    if (!live) return;
    let alive = true;
    fetch(`/api/matching/candidates?request_id=${id}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; data?: CandRow[] }) => {
        if (alive && j.ok) setCandidates(j.data ?? []);
        else if (alive) setCandidates([]); // rate-limited etc.: honest empty
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, live]);

  async function transition(to: string, why: string) {
    setWorking(to);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/requests/${id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, reason: why }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (res.ok && json.ok) {
        setCurrentStatus(to);
      } else {
        setError(json.message ?? `failed (${res.status})`);
      }
    } catch {
      setError(r.errors.network);
    } finally {
      setWorking(null);
    }
  }

  async function notifyDonors() {
    setWorking("notify");
    setError(null);
    try {
      const res = await fetch(`/api/requests/${id}/matches`, { method: "POST" });
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        warning?: string;
        data?: { created: number; total: number };
      };
      if (res.status === 307 || res.status === 401) {
        setError(r.errors.network);
      } else if (json.ok && json.data) {
        setNotice(
          json.data.total === 0
            ? d.notifyNone
            : d.notifyResult.replace("{created}", String(json.data.created)).replace("{total}", String(json.data.total))
        );
        if (json.warning) setError(json.warning);
        // Matches were created: reload so the lists reflect the server truth.
        window.location.reload();
      } else {
        setError(json.message ?? `failed (${res.status})`);
      }
    } catch {
      setError(r.errors.network);
    } finally {
      setWorking(null);
    }
  }

  async function reveal(donorId: string) {
    setWorking(`reveal-${donorId}`);
    setError(null);
    try {
      const res = await fetch(`/api/requests/${id}/contact/${donorId}`);
      const json = (await res.json()) as { ok: boolean; message?: string; data?: { phone: string } };
      if (res.ok && json.ok && json.data) {
        setRevealed((p) => ({ ...p, [donorId]: json.data as { phone: string } }));
      } else {
        setRevealed((p) => ({ ...p, [donorId]: "error" }));
      }
    } catch {
      setRevealed((p) => ({ ...p, [donorId]: "error" }));
    } finally {
      setWorking(null);
    }
  }

  const urgencyLabels: Record<string, string> = {
    routine: r.form.urgencyRoutine,
    urgent: r.form.urgencyUrgent,
    critical: r.form.urgencyCritical,
  };
  const tierKey = (tier: unknown) =>
    (["cityTown", "neighbor", "district", "adjacent"] as const)[Math.max(0, Math.min(3, Number(tier) - 1))];

  return (
    <div className="grid gap-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">{String(request.hospital_name)}</h1>
          <Badge tone={currentStatus === "fulfilled" || currentStatus === "connected" ? "brand" : "neutral"}>
            {r.status[currentStatus as keyof typeof r.status]}
          </Badge>
        </div>
        <p className="mt-2 text-[15px] text-ink-600">
          {String(request.blood_group)} · {String(request.units_needed)} {d.units} · {urgencyLabels[String(request.urgency)]}
        </p>
        <p className="mt-1 text-sm text-ink-500">
          {d.requiredBy}: {new Date(String(request.required_by)).toLocaleString()} · {d.contactPref}:{" "}
          {request.contact_pref === "sms" ? r.form.contactSms : request.contact_pref === "phone_call" ? r.form.contactPhone : r.form.contactInApp}
        </p>
        <Link href="/requests" className="mt-3 inline-block text-sm font-semibold text-red-700 underline hover:no-underline">
          {d.backToList}
        </Link>
      </header>

      {active ? (
        <Card className="p-6">
          <h2 className="text-base font-bold text-ink-900">{d.actions}</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {currentStatus === "draft" ? (
              <ActButton label={d.submitDraft} working={working === "submit"} onClick={() => transition("submitted", "owner submitted")} />
            ) : null}
            {live ? (
              <>
                <ActButton label={d.notifyDonors} working={working === "notify"} onClick={notifyDonors} />
                <ActButton label={d.cancel} working={working === "cancelled"} secondary onClick={() => transition("cancelled", "owner cancelled")} />
              </>
            ) : null}
          </div>
          {notice ? <p className="mt-3 text-sm text-teal-600">{notice}</p> : null}
          {error ? (
            <div className="mt-3">
              <Alert tone="error" title={r.errors.heading}>
                <span>{error}</span>
              </Alert>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="p-6">
        <h2 className="text-base font-bold text-ink-900">{d.candidatesHeading}</h2>
        <p className="mt-1 text-sm text-ink-600">{d.candidatesHint}</p>
        {live ? (
          candidates === null ? (
            <ul className="mt-3 grid gap-2 text-sm text-ink-400">
              <li>…</li>
            </ul>
          ) : candidates.length === 0 ? (
            <p className="mt-3 text-[15px] text-ink-600">{d.candidatesEmpty}</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {candidates.map((c) => (
                <li key={c.donor_user_id} className="flex flex-wrap items-center gap-3 border-b border-ink-100 pb-3 last:border-b-0 last:pb-0">
                  <span className="font-semibold text-ink-900">{c.display_name}</span>
                  <span className="text-sm text-ink-600">
                    {c.upazila_name} · {c.district_name} · {c.blood_group}
                  </span>
                  <Badge>{d.tierLabels[tierKey(c.tier)]}</Badge>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </Card>

      <Card className="p-6">
        <h2 className="text-base font-bold text-ink-900">{d.matchesHeading}</h2>
        {matches.length === 0 ? (
          <p className="mt-2 text-[15px] text-ink-600">{d.matchesEmpty}</p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {matches.map((m) => {
              const donorId = String(m.donor_user_id);
              const mStatus = String(m.status);
              const revealedFor = revealed[donorId];
              return (
                <li key={donorId} className="flex flex-wrap items-center gap-3 border-b border-ink-100 pb-3 last:border-b-0 last:pb-0">
                  <span className="font-semibold text-ink-900">{String(m.display_name)}</span>
                  <Badge tone={mStatus === "accepted" ? "brand" : "neutral"}>
                    {d.matchStatus[mStatus as keyof typeof d.matchStatus] ?? mStatus}
                  </Badge>
                  {mStatus === "accepted" ? (
                    revealedFor && revealedFor !== "error" ? (
                      <span className="text-sm text-ink-800">
                        {d.revealedLabel} <a href={`tel:${revealedFor.phone}`} className="font-semibold underline">{revealedFor.phone}</a>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => reveal(donorId)}
                        disabled={working === `reveal-${donorId}`}
                        className="inline-flex h-9 items-center rounded-lg border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
                      >
                        {working === `reveal-${donorId}` ? d.revealWorking : d.revealCta}
                      </button>
                    )
                  ) : null}
                  {revealedFor === "error" ? <span className="text-sm text-red-700">{d.revealError}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="text-base font-bold text-ink-900">{d.historyHeading}</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-ink-600">{d.historyEmpty}</p>
        ) : (
          <ul className="mt-2 grid gap-1 text-sm text-ink-600">
            {history.map((h, i) => (
              <li key={i}>
                {d.historyBody
                  .replace("{from}", r.status[(h.from_status as keyof typeof r.status) ?? "draft"] ?? String(h.from_status))
                  .replace("{to}", r.status[h.to_status as keyof typeof r.status] ?? String(h.to_status))}{" "}
                · {new Date(String(h.created_at)).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ActButton({
  label,
  working,
  secondary,
  onClick,
}: {
  label: string;
  working: boolean;
  secondary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={working}
      className={
        secondary
          ? "inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold text-ink-700 hover:bg-ink-100 disabled:opacity-60"
          : "inline-flex h-10 items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
      }
    >
      {label}
    </button>
  );
}
