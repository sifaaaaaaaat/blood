import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { listPublished } from "@/src/lib/services/content";
import { ArticleList } from "@/src/components/site/ArticleList";

export const metadata: Metadata = { title: "Blog", alternates: { canonical: "./" } };
export const dynamic = "force-dynamic";

export default async function BlogPage() {
  const { dict, locale } = await getDictionary();
  const result = await listPublished("blog");
  return (
    <ArticleList
      title={dict.content.blogTitle}
      subtitle={dict.content.blogSubtitle}
      emptyMessage={dict.content.empty}
      articles={result.ok ? result.data : []}
      locale={locale}
    />
  );
}
