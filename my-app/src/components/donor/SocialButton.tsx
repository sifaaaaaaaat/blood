"use client";

import { useState, type MouseEvent } from "react";

/**
 * Social sign-in button (Phase 12) — real OAuth, not decorative.
 * Posts to /api/auth/oauth, then sends the browser to the provider URL
 * Supabase returns. Honest failure: if the provider is not yet enabled in
 * the Supabase project, the error text is shown instead of a fake success.
 */

/** Brand glyphs (inline SVG, currentColor-safe) */
function GoogleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.56-5.17 3.56-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.87-3c-1.07.72-2.44 1.14-4.08 1.14-3.14 0-5.8-2.12-6.75-4.97H1.27v3.1A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.25 14.26a7.2 7.2 0 0 1 0-4.52v-3.1H1.27a12 12 0 0 0 0 10.72l3.98-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0 7.3 0 3.25 2.7 1.27 6.64l3.98 3.1C6.2 6.9 8.86 4.77 12 4.77Z"
      />
    </svg>
  );
}
function FacebookIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="#1877F2"
        d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.95.93-1.95 1.88v2.27h3.32l-.53 3.49h-2.79V24C19.61 23.09 24 18.1 24 12.07Z"
      />
    </svg>
  );
}
function AppleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="currentColor"
        d="M17.05 12.54c-.02-2.5 2.04-3.7 2.13-3.76-1.16-1.7-2.97-1.93-3.61-1.96-1.54-.16-3 .9-3.78.9-.78 0-1.98-.88-3.25-.86-1.67.02-3.21.97-4.07 2.47-1.74 3.01-.44 7.47 1.25 9.91.83 1.19 1.81 2.53 3.1 2.48 1.25-.05 1.72-.8 3.23-.8 1.5 0 1.93.8 3.25.78 1.34-.02 2.19-1.22 3.01-2.42.95-1.38 1.34-2.72 1.36-2.79-.03-.01-2.6-1-2.62-3.95ZM14.56 4.9c.69-.83 1.15-1.99 1.02-3.15-.99.04-2.19.66-2.9 1.49-.63.73-1.19 1.91-1.04 3.04 1.11.09 2.23-.56 2.92-1.38Z"
      />
    </svg>
  );
}

function glyph(provider: string) {
  if (provider === "google") return <GoogleIcon />;
  if (provider === "facebook") return <FacebookIcon />;
  return <AppleIcon />;
}

export function SocialButton({
  provider,
  ariaLabel,
  next,
}: {
  provider: "google" | "facebook" | "apple";
  ariaLabel: string;
  next: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function go(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/oauth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, next }),
      });
      const json = (await res.json()) as { ok: boolean; data?: { url?: string }; message?: string };
      if (res.ok && json.ok && json.data?.url) {
        // Supabase hands back the provider's consent URL — navigate for real.
        window.location.href = json.data.url;
        return;
      }
      setError(json.message ?? "social sign-in is not available right now");
    } catch {
      setError("network error — try again");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={working}
        aria-label={ariaLabel}
        title={ariaLabel}
        className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-ink-300 bg-white text-ink-800 shadow-sm transition-colors hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-accent-500 disabled:pointer-events-none disabled:opacity-60"
      >
        {working ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink-300 border-t-transparent" />
        ) : (
          glyph(provider)
        )}
      </button>
      {error ? (
        <p role="alert" className="text-xs leading-snug text-brand-700">
          {error}
        </p>
      ) : null}
    </>
  );
}
