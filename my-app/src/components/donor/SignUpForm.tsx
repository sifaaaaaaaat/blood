"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/src/components/ui/primitives";
import { SocialButton } from "./SocialButton";
import { useRouter } from "next/navigation";

/**
 * Email + password sign-up form (Phase 12).
 * Posts to /api/auth/signup with email, password, and password confirmation.
 * On success, Supabase creates the auth user and sets the session cookie.
 * On failure, returns useful error messages for weak passwords, duplicate accounts, etc.
 * Does NOT send a magic-link sign-in email.
 */
export function SignUpForm({
  next,
  labels,
}: {
  next: string;
  labels: {
    socialDivider: string;
    socialGoogle: string;
    socialFacebook: string;
    socialApple: string;
  };
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    setNotice(null);

    // Validate password match
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setSending(false);
      return;
    }

    // Validate password strength
    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      setSending(false);
      return;
    }

    // Validate email format
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!emailRegex.test(email)) {
      setError("Please enter a valid email address.");
      setSending(false);
      return;
    }

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        code?: string;
        needsConfirmation?: boolean;
      };
      if (res.ok && json.ok) {
        // When the project requires email confirmation, Supabase creates the
        // user but issues no session, so sending the visitor to /profile only
        // bounces them to the login page with no explanation. Tell them to
        // confirm instead.
        if (json.needsConfirmation) {
          setNotice(
            "Account created. Check your inbox for the confirmation link, then sign in."
          );
          setPassword("");
          setConfirmPassword("");
          setSending(false);
          return;
        }
        router.push("/profile");
      } else {
        const errMsg =
          json.code === "duplicate_email"
            ? json.message ?? "An account with this email already exists."
            : json.message ?? "Sign-up problem. Please try again.";
        setError(errMsg);
      }
    } catch {
      setError("network error — try again");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      {error ? (
        <Alert tone="error" title="Registration problem">
          <span>{error}</span>
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="success" title="Confirm your email">
          <span>{notice}</span>
        </Alert>
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
      <div className="grid gap-1.5">
        <label htmlFor="password" className="text-sm font-semibold text-ink-800">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="confirmPassword" className="text-sm font-semibold text-ink-800">
          Confirm password
        </label>
        <input
          id="confirmPassword"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
        />
      </div>
      <button
        type="submit"
        disabled={sending || email.length === 0 || password.length < 8}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800 disabled:pointer-events-none disabled:opacity-60"
      >
        {sending ? "Registering…" : "Register"}
      </button>
      <div className="flex items-center gap-3 pt-1" aria-hidden>
        <span className="h-px flex-1 bg-ink-200" />
        <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
          {labels.socialDivider}
        </span>
        <span className="h-px flex-1 bg-ink-200" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <SocialButton provider="google" ariaLabel={labels.socialGoogle} next={next} />
        <SocialButton provider="facebook" ariaLabel={labels.socialFacebook} next={next} />
        <SocialButton provider="apple" ariaLabel={labels.socialApple} next={next} />
      </div>
    </form>
  );
}