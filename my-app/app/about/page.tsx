import type { Metadata } from "next";
import { pendingMetadata, pendingRoutePage } from "@/src/components/site/pending-page-factory";

export const metadata: Metadata = pendingMetadata("aboutContact", {
  en: "About",
  bn: "আমাদের সম্পর্কে",
});

export default async function AboutPage() {
  return await pendingRoutePage("aboutContact");
}
