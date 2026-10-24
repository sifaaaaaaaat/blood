"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Alert } from "@/src/components/ui/primitives";
import { SocialButton } from "./SocialButton";
import { useRouter } from "next/navigation";

/**
 * Email + password sign-in form (Phase 12).
 * Posts to /api/auth/signin with email and password.
 * On success, Supabase sets the session cookie and the user is redirected.
 * Does NOT send a magic-link sign-in email.
 */
export function SignInForm({
  labels,
  next,
  callbackError,
}: {
  labels: {
    loginSubtitle: string;
    emailLabel: string;
    emailPlaceholder: string;
    passwordLabel: string;
    passwordPlaceholder: string;
    signIn: string;
    signingIn: string;
    signInError: string;
    signInInvalidCredentials: string;
    signInUnconfirmed: string;
    signInGeneric: string;
    alreadySignedIn: string;
    goProfile: string;
    socialDivider: string;
    socialGoogle: string;
    socialFacebook: string;
    socialApple: string;
    forgotPasswordLink: string;
  };
  next: string;
  callbackError: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        message?: string;
        code?: string;
      };
      if (res.ok && json.ok) {
        const redirectTo =
          next && /^\/((?!\/)[A-Za-z0-9/_?=&.-]*)$/.test(next)
            ? next
            : "/profile";
        router.push(redirectTo);
      } else {
        // Known codes have localized labels (the server message is English);
        // anything else falls back to the server's message or the generic label.
        const errs: Record<string, string> = {
          invalid_credentials: labels.signInInvalidCredentials,
          email_not_confirmed: labels.signInUnconfirmed,
        };
        const errMsg =
          (json.code && errs[json.code]) || json.message || labels.signInGeneric;
        setError(errMsg);
      }
    } catch {
      setError("network error — try again");
    } finally {
      setSending(false);
    }
  }

  const passwordInput = showPassword ? (
    <input
      type="text"
      id="password"
      required
      autoComplete="current-password"
      value={password}
      onChange={(e) => setPassword(e.target.value)}
      className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
    />
  ) : (
    <input
      type="password"
      id="password"
      required
      autoComplete="current-password"
      value={password}
      onChange={(e) => setPassword(e.target.value)}
      className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
    />
  );

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      {callbackError ? (
        <Alert tone="error" title={labels.signInError}>
          <span>{callbackError}</span>
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error" title={labels.signInError}>
          <span>{error}</span>
        </Alert>
      ) : null}
      <div className="grid gap-1.5">
        <label htmlFor="email" className="text-sm font-semibold text-ink-800">
          {labels.emailLabel}
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder={labels.emailPlaceholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 rounded-lg border border-ink-300 bg-white px-3 text-[15px] outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="password" className="text-sm font-semibold text-ink-800">
          {labels.passwordLabel}
        </label>
        {passwordInput}
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className="inline-flex items-center gap-2 text-sm text-ink-600 underline hover:underline-opacity-100"
        >
          {showPassword ? "Hide" : "Show"} password
        </button>
      </div>
      <button
        type="submit"
        disabled={sending || email.length === 0 || password.length === 0}
        className="inline-flex h-11 items-center justify-center rounded-lg bg-red-600 font-semibold text-white shadow-sm transition-colors hover:bg-red-700 active:bg-red-800 disabled:pointer-events-none disabled:opacity-60"
      >
        {sending ? labels.signingIn : labels.signIn}
      </button>
      <Link
        href="/forgot"
        className="justify-self-center text-sm text-ink-600 underline underline-offset-2 hover:text-ink-900"
      >
        {labels.forgotPasswordLink}
      </Link>
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