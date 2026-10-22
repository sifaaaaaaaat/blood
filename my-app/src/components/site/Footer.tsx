import Link from "next/link";
import type { Dictionary, Locale } from "@/src/lib/i18n/dictionaries";
import { Logo } from "./Logo";

type FooterLink = { href: string; label: string };

/** Site footer (Phase 11B) — all links point to real routes. */
export function Footer({ locale, dict }: { locale: Locale; dict: Dictionary }) {
  const platform: FooterLink[] = [
    { href: "/requests/new", label: dict.footer.requestBlood },
    { href: "/register", label: dict.footer.register },
    { href: "/directory", label: dict.footer.directory },
    { href: "/camps", label: dict.footer.camps },
    { href: "/notifications", label: dict.footer.notifications },
  ];
  const learn: FooterLink[] = [
    { href: "/donate", label: dict.footer.donate },
    { href: "/faqs", label: dict.footer.faqs },
    { href: "/blog", label: dict.footer.blog },
  ];
  const legal: FooterLink[] = [
    { href: "/about", label: dict.footer.about },
    { href: "/contact", label: dict.footer.contact },
    { href: "/terms", label: dict.footer.terms },
    { href: "/privacy", label: dict.footer.privacy },
  ];

  return (
    <footer className="mt-20 border-t border-ink-200 bg-ink-50">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo locale={locale} />
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-ink-600">{dict.footer.disclaimer}</p>
          </div>
          <FooterColumn title={dict.footer.platformTitle} links={platform} />
          <FooterColumn title={dict.footer.learnTitle} links={learn} />
          <FooterColumn title={dict.footer.legalTitle} links={legal} />
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-ink-200 pt-6 text-sm text-ink-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {dict.footer.copyright}</p>
          <p>{dict.footer.langNote}</p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <nav aria-label={title}>
      <h3 className="text-sm font-bold uppercase tracking-wide text-ink-800">{title}</h3>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={`${title}-${link.label}`}>
            <Link href={link.href} className="text-sm text-ink-600 hover:text-red-700 hover:underline">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
