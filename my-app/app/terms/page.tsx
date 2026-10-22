import type { Metadata } from "next";
import { pendingMetadata, pendingRoutePage } from "@/src/components/site/pending-page-factory";

export const metadata: Metadata = pendingMetadata("legal", {
  en: "Terms of service",
  bn: "সেবার শর্তাবলী",
});

export default async function TermsPage() {
  return await pendingRoutePage("legal");
}
