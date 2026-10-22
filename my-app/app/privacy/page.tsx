import type { Metadata } from "next";
import { pendingMetadata, pendingRoutePage } from "@/src/components/site/pending-page-factory";

export const metadata: Metadata = pendingMetadata("legal", {
  en: "Privacy policy",
  bn: "গোপনীয়তা নীতি",
});

export default async function PrivacyPage() {
  return await pendingRoutePage("legal");
}
