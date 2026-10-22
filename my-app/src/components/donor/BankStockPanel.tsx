"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/src/components/ui/primitives";
import { bloodGroups } from "@/src/lib/validation/donor";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

type StockRow = { blood_group: string; units: number; created_at: string; source_note: string | null };

/**
 * Stock reporting panel (Phase 11F). Reads the bank's own history and posts
 * timestamped updates through the member API. Nothing is ever fabricated:
 * the public directory shows exactly what legitimate bank members report.
 */
export function BankStockPanel({
  dict,
  bankId,
  bankName,
}: {
  dict: Dictionary;
  bankId: string;
  bankName: string;
}) {
  const b = dict.bank;
  const [history, setHistory] = useState<StockRow[] | null>(null);
  const [rows, setRows] = useState<{ group: string; units: string }[]>([{ group: "", units: "" }]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/org/banks/${bankId}/stock`)
      .then((r) => r.json())
      .then((j: { ok: boolean; data?: StockRow[] }) => {
        if (alive && j.ok) setHistory(j.data ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bankId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const updates = rows
        .filter((r) => r.group !== "" && r.units !== "")
        .map((r) => ({ blood_group: r.group, units: Number(r.units) }));
      const res = await fetch(`/api/org/banks/${bankId}/stock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates, source_note: note || undefined }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string; data?: { inserted: number } };
      if ((res.status === 201 || res.ok) && json.ok) {
        setSavedMsg(b.saved.replace("{n}", String(json.data?.inserted ?? updates.length)));
        setRows([{ group: "", units: "" }]);
        const h = await fetch(`/api/org/banks/${bankId}/stock`);
        const hj = (await h.json()) as { ok: boolean; data?: StockRow[] };
        if (hj.ok) setHistory(hj.data ?? []);
      } else {
        setError(json.message ?? `failed (${res.status})`);
      }
    } catch {
      setError("network error — try again");
    } finally {
      setSaving(false);
    }
  }

  const input =
    "h-10 rounded-lg border border-ink-300 bg-white px-3 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100";

  return (
    <div className="mt-4 grid gap-4">
      <form onSubmit={submit} className="grid gap-3 rounded-lg border border-ink-100 bg-ink-50 p-4">
        <h3 className="text-sm font-bold text-ink-900">{b.reportTitle}</h3>
        <p className="text-xs text-ink-500">
          {b.reportHelp.replace("the", "")} — {bankName}
        </p>
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              className={`${input} w-36`}
              value={row.group}
              onChange={(e) => setRows((p) => p.map((r, j) => (j === i ? { ...r, group: e.target.value } : r)))}
              aria-label={b.groupLabel}
            >
              <option value="">{b.groupLabel}</option>
              {bloodGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              max={10000}
              className={`${input} w-28`}
              placeholder={b.unitsLabel}
              value={row.units}
              onChange={(e) => setRows((p) => p.map((r, j) => (j === i ? { ...r, units: e.target.value } : r)))}
              aria-label={b.unitsLabel}
            />
            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
                className="text-xs font-semibold text-ink-500 underline hover:text-ink-700"
              >
                {b.removeRow}
              </button>
            ) : null}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setRows((p) => [...p, { group: "", units: "" }])}
            className="text-sm font-semibold text-red-700 underline hover:no-underline"
          >
            {b.addRow}
          </button>
          <input
            className={`${input} flex-1`}
            maxLength={200}
            placeholder={b.noteLabel}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={b.noteLabel}
          />
          <button
            type="submit"
            disabled={saving || rows.every((r) => !r.group || !r.units)}
            className="inline-flex h-10 items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
          >
            {saving ? b.sending : b.send}
          </button>
        </div>
        {savedMsg ? <p className="text-sm text-teal-600">{savedMsg}</p> : null}
        {error ? (
          <Alert tone="error" title={b.errors.heading}>
            <span>{error}</span>
          </Alert>
        ) : null}
      </form>

      <div>
        <h3 className="text-sm font-bold text-ink-900">{b.historyTitle}</h3>
        {history === null ? null : history.length === 0 ? (
          <p className="mt-1 text-sm text-ink-600">{b.historyEmpty}</p>
        ) : (
          <ul className="mt-2 grid gap-1 text-sm text-ink-600">
            {history.map((h, i) => (
              <li key={i}>
                {new Date(h.created_at).toLocaleString()} · {h.blood_group}: {h.units}
                {h.source_note ? ` · ${h.source_note}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
