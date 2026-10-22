import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { PhasePending } from "@/src/components/site/PhasePending";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";

/** Route keys whose real workflows ship in later Phase 11 packages.
 * 11D (donorRegistration) and 11E (request) shipped their real pages and are
 * no longer pending routes. */
export type PendingRoute =
  | "directory"
  | "camps"
  | "notifications"
  | "content"
  | "aboutContact"
  | "legal"
  | "thalassemia";

type PhaseNames = Dictionary["phaseNames"];
type PendingDictionary = Dictionary["pending"];

/** Per-route description shown on the pending page (English copy references the
 * EN dictionary; the locale-aware wording lives in each entry below). */
const ROUTE_COPY: Record<
  PendingRoute,
  { phase: (p: PhaseNames) => string; descriptionEn: string; descriptionBn: string }
> = {
  directory: {
    phase: (p) => p.directory,
    descriptionEn:
      "Searchable blood-bank directory with division/district filters and stock shown only from verified, timestamped updates.",
    descriptionBn:
      "বিভাগ/জেলা ফিল্টারসহ ব্লাড ব্যাংক ডিরেক্টরি — কেবল যাচাইকৃত, সময়চিহ্নিত আপডেট থাকলে তবেই স্টক দেখানো হবে।",
  },
  camps: {
    phase: (p) => p.camps,
    descriptionEn:
      "Camp discovery with real listings, filters and reminders — no invented events will be published.",
    descriptionBn:
      "প্রকৃত তালিকা, ফিল্টার ও রিমাইন্ডারসহ ক্যাম্প আবিষ্কার — কোনো বানানো ইভেন্ট প্রকাশ করা হবে না।",
  },
  notifications: {
    phase: (p) => p.notifications,
    descriptionEn:
      "Platform announcements and notification listings — clearly separated from real donor-request delivery status.",
    descriptionBn:
      "প্ল্যাটফর্ম ঘোষণা ও সংবাদ তালিকা — প্রকৃত দাতা-অনুরোধ ডেলিভারি স্টেটাস থেকে স্পষ্টভাবে আলাদা।",
  },
  content: {
    phase: (p) => p.content,
    descriptionEn:
      "FAQs and educational articles with category browsing, search and full Bangla/English content.",
    descriptionBn:
      "সাধারণ প্রশ্ন ও শিক্ষামূলক নিবন্ধ — ক্যাটাগরি ব্রাউজিং, সার্চ এবং সম্পূর্ণ বাংলা/ইংরেজি বিষয়বস্তুসহ।",
  },
  aboutContact: {
    phase: (p) => p.aboutContact,
    descriptionEn:
      "About and contact pages with real, owner-provided information — nothing invented in the meantime.",
    descriptionBn:
      "আমাদের সম্পর্কে ও যোগাযোগ পৃষ্ঠা — মালিক-প্রদত্ত প্রকৃত তথ্যসহ; এর মধ্যে কিছু বানানো হবে না।",
  },
  legal: {
    phase: (p) => p.legal,
    descriptionEn:
      "Terms and privacy copy specific to this service and Bangladesh jurisdiction — published only after legal review.",
    descriptionBn:
      "এই সেবা ও বাংলাদেশের প্রেক্ষাপটে প্রযোজ্য শর্তাবলী ও গোপনীয়তা নীতি — আইনি পর্যালোচনার পরেই প্রকাশ হবে।",
  },
  thalassemia: {
    phase: (p) => p.thalassemia,
    descriptionEn:
      "Thalassemia support and recurring blood requests. The agreed roadmap includes this feature; its data model, schedules and consent rules need a product decision before build.",
    descriptionBn:
      "থ্যালাসেমিয়া সহায়তা ও পুনরাবৃত্ত রক্তের অনুরোধ। সম্মত রোডম্যাপে এই ফিচারটি রয়েছে; নির্মাণের আগে এর ডেটা মডেল, সময়সূচি ও সম্মতি নিয়মে পণ্য-সিদ্ধান্ত প্রয়োজন।",
  },
};

/** Build the page content for a pending route (called from each page.tsx). */
export async function pendingRoutePage(route: PendingRoute) {
  const { locale, dict } = await getDictionary();
  const copy = ROUTE_COPY[route];
  return (
    <PhasePending
      phase={copy.phase(dict.phaseNames)}
      description={locale === "bn" ? copy.descriptionBn : copy.descriptionEn}
      backLabel={dict.pending.backHome}
      pendingHeading={dict.pending.heading}
      pendingBody={dict.pending.body}
      phaseLabel={dict.pending.phaseLabel}
    />
  );
}

export function pendingMetadata(
  route: PendingRoute,
  titles: Record<"en" | "bn", string>
): Metadata {
  return { title: titles.en, alternates: { canonical: "./" }, openGraph: { title: titles.bn } };
}

export type { PendingDictionary };
