import type { ReactNode } from "react";
import Link from "next/link";

/**
 * UI primitives (Phase 11B). Minimal, server-compatible, Tailwind-only so they
 * compose in both server and client components without extra dependencies.
 */

const BUTTON_VARIANTS = {
  primary:
    "bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm disabled:opacity-60",
  secondary:
    "bg-white text-red-700 border border-red-200 hover:bg-red-50 active:bg-red-100",
  neutral:
    "bg-ink-100 text-ink-800 hover:bg-ink-200 active:bg-ink-300",
  ghost:
    "bg-transparent text-ink-700 hover:bg-ink-100 active:bg-ink-200",
} as const;

const BUTTON_SIZES = {
  sm: "h-9 px-3.5 text-sm gap-1.5",
  md: "h-11 px-5 text-[15px] gap-2",
  lg: "h-12 px-6 text-base gap-2",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

const baseButton =
  "inline-flex items-center justify-center rounded-lg font-semibold transition-colors select-none whitespace-nowrap disabled:pointer-events-none";

export function ButtonStyles({
  variant = "primary",
  size = "md",
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}): string {
  return `${baseButton} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`;
}

/** Anchored CTA that must look/behave like a button (real navigation via Link). */
export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className = "",
  children,
  ariaLabel,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <Link href={href} className={ButtonStyles({ variant, size, className })} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "warning";
  className?: string;
}) {
  const tones = {
    neutral: "bg-ink-100 text-ink-700",
    brand: "bg-red-100 text-red-700",
    warning: "bg-amber-warm-50 text-amber-warm-600",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag className={`rounded-card border border-ink-200 bg-white shadow-sm ${className}`}>
      {children}
    </Tag>
  );
}

export function SectionHeading({
  id,
  title,
  subtitle,
  action,
  className = "",
}: {
  id?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="max-w-2xl">
        <h2 id={id} className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{title}</h2>
        {subtitle ? <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Honest empty/pending placeholder. Never shows fabricated content. */
export function EmptyState({
  icon,
  message,
  className = "",
}: {
  icon?: ReactNode;
  message: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-card border border-dashed border-ink-300 bg-ink-50 px-6 py-10 text-center ${className}`}
    >
      {icon ? <div className="text-ink-400">{icon}</div> : null}
      <p className="max-w-md text-sm leading-relaxed text-ink-600">{message}</p>
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
  className = "",
}: {
  tone?: "info" | "warning" | "error" | "success";
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-teal-500/30 bg-teal-50 text-teal-600",
    warning: "border-amber-300 bg-amber-warm-50 text-amber-warm-600",
    error: "border-red-300 bg-red-50 text-red-700",
    success: "border-teal-500/30 bg-teal-50 text-teal-600",
  } as const;
  return (
    <div role="status" className={`rounded-card border px-4 py-3 text-sm ${tones[tone]} ${className}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1 leading-relaxed" : "leading-relaxed"}>{children}</div> : null}
    </div>
  );
}
