import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { listPublishedCached } from "@/src/lib/services/cached-reads";
import { ArticleList } from "@/src/components/site/ArticleList";

export const metadata: Metadata = { title: "Donation guide", alternates: { canonical: "./" } };
export const dynamic = "force-dynamic";

export default async function DonatePage() {
  const { dict, locale } = await getDictionary();
  const result = await listPublishedCached("guide");
  return (
    <ArticleList
      title={dict.content.donateTitle}
      subtitle={dict.content.donateSubtitle}
      emptyMessage={dict.content.empty}
      articles={result.ok ? result.data : []}
      locale={locale}
    />
  );
}
