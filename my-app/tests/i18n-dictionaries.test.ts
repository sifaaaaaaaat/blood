import { describe, expect, it } from "vitest";
import { dictionaries, LOCALES, LOCALE_COOKIE } from "@/src/lib/i18n/dictionaries";
import { localeFromCookieHeader } from "@/src/lib/i18n/server";

/**
 * Phase 11B — the language toggle must change REAL interface text.
 * Parity test: the Bangla dictionary must contain every English key with a
 * non-empty string, and vice versa (no silently-missing translations).
 */

type DictNode = string | { [key: string]: DictNode };

function flatten(node: DictNode, prefix: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") {
    out.set(prefix.join("."), node);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    for (const [k, v] of flatten(value as DictNode, [...prefix, key])) {
      out.set(k, v);
    }
  }
  return out;
}

describe("i18n dictionaries", () => {
  it("both locales are registered", () => {
    for (const locale of LOCALES) {
      expect(dictionaries[locale]).toBeDefined();
    }
  });

  it("bn has exactly the same keys as en", () => {
    const en = flatten(dictionaries.en);
    const bn = flatten(dictionaries.bn);
    expect([...bn.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it("every translated string in both locales is non-empty", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(dictionaries[locale])) {
        expect(value.trim().length, `${locale}:${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("Bangla strings contain Bengali script where they materially differ from EN", () => {
    const en = flatten(dictionaries.en);
    const bn = flatten(dictionaries.bn);
    // Spot-check a representative sample rather than characterise every string.
    for (const key of ["nav.home", "stats.title", "hero.title.line2", "footer.platformTitle"]) {
      const bnValue = bn.get(key) ?? "";
      const enValue = en.get(key) ?? "";
      // Bengali Unicode range U+0980–U+09FF; the values also legitimately
      // contain Latin tokens such as "Phase 11D".
      const hasBengali = /[\u0980-\u09FF]/.test(bnValue);
      expect(hasBengali || bnValue !== enValue, `${key} untranslated`).toBe(true);
    }
  });

  it("key differs between locales for at least one nav label", () => {
    expect(dictionaries.en.nav.home).not.toBe(dictionaries.bn.nav.home);
  });
});

describe("locale cookie parsing", () => {
  it("parses rs_locale=bm from a cookie header", () => {
    expect(localeFromCookieHeader(`${LOCALE_COOKIE}=bn; other=1`)).toBe("bn");
  });

  it("parses rs_locale=en", () => {
    expect(localeFromCookieHeader(`a=b; ${LOCALE_COOKIE}=en`)).toBe("en");
  });

  it("falls back to en for missing or invalid values", () => {
    expect(localeFromCookieHeader(null)).toBe("en");
    expect(localeFromCookieHeader("")).toBe("en");
    expect(localeFromCookieHeader(`${LOCALE_COOKIE}=fr`)).toBe("en");
  });
});
