"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Dictionary, Locale } from "@/src/lib/i18n/dictionaries";
import { LOCALE_COOKIE } from "@/src/lib/i18n/dictionaries";
import { Logo } from "./Logo";
import { ButtonLink } from "@/src/components/ui/primitives";

type NavItem = { href: string; label: string; badge?: string };

/**
 * Application header (Phase 11B).
 * Every item links to a real route — the two later-phase entries carry an
 * explicit "Soon" badge pointing at an honest pending page, never a dead link.
 */
export function Header({ locale, dict, signedIn }: { locale: Locale; dict: Dictionary; signedIn?: boolean | null }) {
  const [openMenu, setOpenMenu] = useState<"looking" | "donate" | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  /** Close menus on direct user interaction (navigation clicks, Escape,
   * outside clicks) — no setState-in-effect, per lint rule. */
  function closeAll() {
    setOpenMenu(null);
    setDrawerOpen(false);
  }
  const closeAllOnClick = (e: ReactMouseEvent) => {
    // Real link navigation closes the menus; click handlers run before the
    // route change, so this covers every internal link in the header.
    const target = e.target as HTMLElement;
    if (target.closest("a[href]")) closeAll();
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenMenu(null);
        setDrawerOpen(false);
      }
    }
    function onClick(e: MouseEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, []);

  function switchLocale() {
    const next: Locale = locale === "en" ? "bn" : "en";
    document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    router.refresh();
  }

  const lookingItems: NavItem[] = [
    { href: "/requests/new", label: dict.nav.requestBlood },
    { href: "/directory", label: dict.nav.bloodBankDirectory },
    { href: "/thalassemia", label: dict.nav.thalassemia, badge: dict.nav.soon },
  ];
  const donateItems: NavItem[] = [
    { href: "/register", label: dict.nav.becomeDonor },
    { href: "/donate", label: dict.nav.donationGuide },
    { href: "/donate", label: dict.nav.eligibility },
  ];
  const drawerGroups: { heading: string; items: NavItem[] }[] = [
    { heading: dict.nav.lookingForBlood, items: lookingItems },
    { heading: dict.nav.donateBlood, items: donateItems },
  ];

  return (
    <header ref={headerRef} onClick={closeAllOnClick} className="sticky top-0 z-50 border-b border-ink-200 bg-white/95 backdrop-blur">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-ink-900 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        {dict.header.skipToContent}
      </a>
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Logo locale={locale} className="mr-2" />

        {/* Desktop nav */}
        <nav aria-label={dict.nav.home} className="ml-2 hidden items-center gap-1 lg:flex">
          <Dropdown
            id="looking"
            label={dict.nav.lookingForBlood}
            items={lookingItems}
            open={openMenu === "looking"}
            onToggle={() => setOpenMenu(openMenu === "looking" ? null : "looking")}
          />
          <Dropdown
            id="donate"
            label={dict.nav.donateBlood}
            items={donateItems}
            open={openMenu === "donate"}
            onToggle={() => setOpenMenu(openMenu === "donate" ? null : "donate")}
          />
          <NavLink href="/directory" label={dict.nav.bloodBankDirectory} active={pathname === "/directory"} />
          <NavLink href="/camps" label={dict.nav.camps} active={pathname === "/camps"} />
          <NavLink href="/about" label={dict.nav.about} active={pathname === "/about"} />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={switchLocale}
            className="inline-flex h-9 items-center rounded-lg border border-ink-200 bg-white px-3 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            aria-label={` ${dict.header.languageLabel}: ${locale === "en" ? "EN → বাংলা" : "বাংলা → EN"}`}
          >
            {locale === "en" ? dict.header.switchToBn : dict.header.switchToEn}
          </button>
          <div className="hidden sm:block">
            {/* Phase 11D: signed-in users land on their profile, not sign-in */}
            <Link
              href={signedIn ? "/profile" : "/login"}
              className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            >
              {signedIn ? dict.nav.profile : dict.nav.login}
            </Link>
          </div>
          <div className="hidden md:block">
            <ButtonLink href="/requests/new" size="sm">
              {dict.header.primaryCta}
            </ButtonLink>
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-800 hover:bg-ink-100 lg:hidden"
            aria-expanded={drawerOpen}
            aria-label={drawerOpen ? dict.header.menuClose : dict.header.menuOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              {drawerOpen ? (
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              ) : (
                <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="border-t border-ink-200 bg-white lg:hidden">
          <nav className="mx-auto max-w-6xl px-4 py-4 sm:px-6" aria-label={dict.nav.menu}>
            {drawerGroups.map((group) => (
              <div key={group.heading} className="mb-4">
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-ink-500">{group.heading}</p>
                <ul className="flex flex-col">
                  {group.items.map((item) => (
                    <li key={`${group.heading}-${item.label}`}>
                      <Link
                        href={item.href}
                        className="flex items-center justify-between rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-800 hover:bg-ink-100"
                      >
                        {item.label}
                        {item.badge ? <BadgeSoor text={item.badge} /> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="flex flex-col gap-1 border-t border-ink-100 pt-3">
              <Link href="/login" className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-800 hover:bg-ink-100">
                {dict.nav.login}
              </Link>
              <Link href="/blog" className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-800 hover:bg-ink-100">
                {dict.nav.blog}
              </Link>
              <Link href="/contact" className="rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-800 hover:bg-ink-100">
                {dict.nav.contact}
              </Link>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 pb-2">
              <ButtonLink href="/requests/new" size="md">{dict.header.primaryCta}</ButtonLink>
              <ButtonLink href="/register" variant="secondary" size="md">{dict.header.secondaryCta}</ButtonLink>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
        active ? "bg-red-50 text-red-700" : "text-ink-700 hover:bg-ink-100"
      }`}
    >
      {label}
    </Link>
  );
}

function Dropdown({
  id,
  label,
  items,
  open,
  onToggle,
}: {
  id: string;
  label: string;
  items: NavItem[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={onToggle}
        className={`inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
          open ? "bg-red-50 text-red-700" : "text-ink-700 hover:bg-ink-100"
        }`}
      >
        {label}
        <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="currentColor" aria-hidden="true">
          <path d="M5.5 7.5 10 12l4.5-4.5H5.5Z" />
        </svg>
      </button>
      {open ? (
        <div
          id={`${id}-menu`}
          role="menu"
          aria-label={label}
          className="absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-ink-200 bg-white py-1.5 shadow-lg"
        >
          {items.map((item) => (
            <Link
              key={`${id}-${item.label}`}
              href={item.href}
              role="menuitem"
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium text-ink-800 hover:bg-red-50"
            >
              <span>{item.label}</span>
              {item.badge ? <BadgeSoor text={item.badge} /> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BadgeSoor({ text }: { text: string }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-amber-warm-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-warm-600">
      {text}
    </span>
  );
}
