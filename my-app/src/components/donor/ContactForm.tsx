"use client";

import { useState } from "react";
import { Alert } from "@/src/components/ui/primitives";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

/**
 * Contact form (Phase 11H): stores the message for platform admins via
 * POST /api/contact. Rate-capped server-side; never displayed publicly.
 */
export function ContactForm({ dict }: { dict: Dictionary }) {
  const c = dict.contact;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, message, consent }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (res.status === 201 && json.ok) {
        setSent(true);
      } else {
        setError(json.message ?? `failed (${res.status})`);
      }
    } catch {
      setError("network error — try again");
    } finally {
      setSending(false);
    }
  }

  const input =
    "h-11 w-full rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100";

  if (sent) {
    return <Alert tone="success" title={c.sent} />;
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      {error ? (
        <Alert tone="error" title={c.errorHeading}>
          <span>{error}</span>
        </Alert>
      ) : null}
      <div className="grid gap-1.5">
        <label htmlFor="ct-name" className="text-sm font-semibold text-ink-800">
          {c.nameLabel}
        </label>
        <input id="ct-name" className={input} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="ct-email" className="text-sm font-semibold text-ink-800">
          {c.emailLabel}
        </label>
        <input id="ct-email" type="email" required className={input} maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="ct-message" className="text-sm font-semibold text-ink-800">
          {c.messageLabel}
        </label>
        <textarea
          id="ct-message"
          required
          rows={5}
          maxLength={4000}
          className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
      <label className="flex items-start gap-3 text-sm font-semibold text-ink-800">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-red-600"
        />
        {c.consentLabel}
      </label>
      <button
        type="submit"
        disabled={sending || message.trim().length < 2 || !email}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 px-5 font-semibold text-white shadow-sm hover:bg-red-700 disabled:pointer-events-none disabled:opacity-60"
      >
        {sending ? c.sending : c.send}
      </button>
    </form>
  );
}
