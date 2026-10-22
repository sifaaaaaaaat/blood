import type { Metadata } from "next";
import { Geist, Geist_Mono, Hind_Siliguri } from "next/font/google";
import "./globals.css";
import { getDictionary } from "@/src/lib/i18n/server";
import { Header } from "@/src/components/site/Header";
import { Footer } from "@/src/components/site/Footer";
import { getServerSession } from "@/src/lib/session";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* Bangla UI font: real Bangla glyphs for bn locale (declared in @theme). */
const hindSiliguri = Hind_Siliguri({
  variable: "--font-hind-siliguri",
  subsets: ["bengali", "latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "RoktoSathi — Find a blood donor when minutes matter",
    template: "%s — RoktoSathi",
  },
  description:
    "Community platform for voluntary blood donation in Bangladesh: request blood, register as a donor, and get matched — with donor privacy protected at every step.",
};

export default async function RootLayout({
  children,
}: LayoutProps<"/">) {
  const { locale, dict } = await getDictionary();
  const session = await getServerSession();

  return (
    <html
      lang={locale === "bn" ? "bn" : "en"}
      className={`${geistSans.variable} ${geistMono.variable} ${hindSiliguri.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white text-ink-900">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-ink-900 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
        >
          {dict.header.skipToContent}
        </a>
        <Header locale={locale} dict={dict} signedIn={Boolean(session)} />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        <Footer locale={locale} dict={dict} />
      </body>
    </html>
  );
}

