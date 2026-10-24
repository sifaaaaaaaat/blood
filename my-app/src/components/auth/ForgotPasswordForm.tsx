"use client";

import { useState } from "react";
import Link from "next/link";

type Labels = {
  forgotSubmit: string;
  forgotSending: string;
  forgotSent: string;
  forgotError: string;
  signInError: string;
};

/**
 * One-email field → POST /api/auth/recovery. The success state is intentionally
 * identical for known and unknown emails (anti-enumeration) — the route owns
 * that rule and renders no signal that could reveal an account.
 */
export function ForgotPasswordForm({ labels }: { labels: Labels }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (res.ok && json?.ok) {
        setSent(true);
      } else {
        setError(labels.forgotError);
      }
    } catch {
      setError(labels.forgotError);
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm leading-relaxed text-green-900">
        {labels.forgotSent}
      </p>
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
        <label htmlFor="email" className="text-sm font-semibold text-ink-800">
          Email address
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
        />
      </div>
      <button
        type="submit"
        disabled={sending || email.length === 0}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800 disabled:pointer-events-none disabled:opacity-60"
      >
        {sending ? labels.forgotSending : labels.forgotSubmit}
      </button>
      <Link href="/login" className="text-sm text-ink-600 underline underline-offset-2 hover:text-ink-900">
        ← Back to log in
      </Link>
    </form>
  );
}
