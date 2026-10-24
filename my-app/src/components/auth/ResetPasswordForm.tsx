"use client";

import { useState } from "react";

type Labels = {
  resetSubmit: string;
  resetSaving: string;
  resetDone: string;
  passwordLabel: string;
  passwordPlaceholder: string;
};

/**
 * Recovery-session form → POST /api/auth/recovery/confirm. On success the API
 * clears other sessions; the user signs in with the new password.
 */
export function ResetPasswordForm({ labels }: { labels: Labels }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/recovery/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; code?: string }
        | null;
      if (res.ok && json?.ok) {
        setDone(true);
      } else {
        setError(json?.code === "weak_password" ? json.message ?? null : json?.message ?? null);
      }
    } catch {
      setError("Network problem — please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm leading-relaxed text-green-900">
          {labels.resetDone}
        </p>
        <a
          href="/login"
          className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800"
        >
          Log in
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <label htmlFor="password" className="text-sm font-semibold text-ink-800">
          {labels.passwordLabel}
        </label>
        <div className="grid gap-1.5">
          <input
            id="password"
            type={show ? "text" : "password"}
            required
            minLength={8}
            autoComplete="new-password"
            placeholder={labels.passwordPlaceholder}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="inline-flex items-center gap-2 text-sm text-ink-600 underline hover:underline-opacity-100"
          >
            {show ? "Hide" : "Show"} password
          </button>
        </div>
      </div>
      <button
        type="submit"
        disabled={saving || password.length < 8}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800 disabled:pointer-events-none disabled:opacity-60"
      >
        {saving ? labels.resetSaving : labels.resetSubmit}
      </button>
    </form>
  );
}
