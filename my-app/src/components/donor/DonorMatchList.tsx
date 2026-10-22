"use client";

import { useState } from "react";
import { Alert, Badge, Card } from "@/src/components/ui/primitives";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

type Row = Record<string, unknown>;

/**
 * The donor's own matches with real in-app actions (Phase 11E backend, 11H
 * surface). Actions POST to /api/matches/[id]/respond (accept/decline/
 * unavailable); the server re-checks every gate and the DB is authoritative.
 */
export function DonorMatchList({ dict, matches }: { dict: Dictionary; matches: Row[] }) {
  const r = dict.requests;
  const [states, setStates] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);

  async function act(matchId: string, action: "accept" | "decline" | "unavailable") {
    setWorking(matchId);
    try {
      const res = await fetch(`/api/matches/${matchId}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      setStates((p) => ({
        ...p,
        [matchId]: res.ok && json.ok
          ? ({ accept: "doneAccepted", decline: "doneDeclined", unavailable: "doneUnavailable" } as const)[action]
          : "error",
      }));
    } catch {
      setStates((p) => ({ ...p, [matchId]: "error" }));
    } finally {
      setWorking(null);
    }
  }

  return (
    <ul className="grid gap-3">
      {matches.map((m) => {
        const id = String(m.id);
        const req = (m.request ?? {}) as Row;
        const status = String(m.status);
        const resolved = states[id];
        const answered = ["accepted", "declined", "unavailable"].includes(status);
        return (
          <li key={id}>
            <Card className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">
                    {String(req.hospital_name)} · {String(req.blood_group)}
                  </p>
                  <p className="text-sm text-ink-600">
                    {String(req.units_needed)} {r.detail.units} ·{" "}
                    {r.detail.requiredBy}:{" "}
                    {new Date(String(req.required_by)).toLocaleString()}
                  </p>
                  {req.location_text ? <p className="text-sm text-ink-500">{String(req.location_text)}</p> : null}
                </div>
                <Badge tone={status === "accepted" ? "brand" : answered ? "neutral" : "warning"}>
                  {r.detail.matchStatus[status as keyof typeof r.detail.matchStatus] ?? status}
                </Badge>
              </div>

              {!answered && !resolved && status !== "expired" ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {(
                    [
                      ["accept", r.donor.accepted],
                      ["decline", r.donor.declined],
                      ["unavailable", r.donor.unavailable],
                    ] as const
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => act(id, action)}
                      disabled={working === id}
                      className={
                        action === "accept"
                          ? "inline-flex h-10 items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                          : "inline-flex h-10 items-center rounded-lg border border-ink-200 bg-white px-4 text-sm font-semibold text-ink-700 hover:bg-ink-100 disabled:opacity-60"
                      }
                    >
                      {working === id ? r.donor.working : label}
                    </button>
                  ))}
                </div>
              ) : null}

              {resolved === "doneAccepted" ? (
                <div className="mt-3">
                  <p className="text-sm text-teal-600">{r.donor.doneAccepted}</p>
                </div>
              ) : null}
              {resolved === "doneDeclined" ? <div className="mt-3"><p className="text-sm text-ink-600">{r.donor.doneDeclined}</p></div> : null}
              {resolved === "doneUnavailable" ? <div className="mt-3"><p className="text-sm text-ink-600">{r.donor.doneUnavailable}</p></div> : null}
              {resolved === "error" || (!answered && resolved === undefined && status === "expired") ? (
                <div className="mt-3">
                  <Alert tone="warning" title={r.donor.errorHeading}>
                    <span>{resolved === "error" ? r.donor.rejected : ""}</span>
                  </Alert>
                </div>
              ) : null}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
