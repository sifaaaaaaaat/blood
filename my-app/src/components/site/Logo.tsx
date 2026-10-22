import Link from "next/link";
import { BRAND } from "@/src/lib/brand";

/**
 * Original logo: a blood-droplet mark drawn inline (no third-party assets) and
 * the wordmark in the current locale. Links home.
 */
export function Logo({ locale, className = "" }: { locale: "en" | "bn"; className?: string }) {
  return (
    <Link
      href="/"
      className={`inline-flex items-center gap-2 rounded-md ${className}`}
      aria-label={`${BRAND.name[locale]} — home`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-7 w-7 shrink-0"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M12 2.5c3.6 4.6 7 8.9 7 13a7 7 0 1 1-14 0c0-4.1 3.4-8.4 7-13Z"
          fill="var(--rs-red-600)"
        />
        <path
          d="M9.2 15.6a3.1 3.1 0 0 0 2.6 3.4"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-lg font-extrabold tracking-tight text-ink-900">
        {BRAND.name[locale]}
      </span>
    </Link>
  );
}
