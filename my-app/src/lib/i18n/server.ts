import { cookies } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  dictionaries,
  isLocale,
  type Dictionary,
  type Locale,
} from "./dictionaries";

/**
 * Locale resolution on the server: a single `rs_locale` cookie governs the
 * rendered language. The LanguageToggle writes that cookie and refreshes, so
 * server components re-render with REAL translated content (no client-only
 * label swap).
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  return raw !== undefined && isLocale(raw) ? raw : DEFAULT_LOCALE;
}

export async function getDictionary(): Promise<{ locale: Locale; dict: Dictionary }> {
  const locale = await getLocale();
  return { locale, dict: dictionaries[locale] };
}

/** Parse a cookie header for the locale (route-handler / test friendly). */
export function localeFromCookieHeader(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  const value = match ? decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1)) : "";
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
