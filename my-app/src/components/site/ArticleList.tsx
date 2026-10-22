import { Card, EmptyState, SectionHeading } from "@/src/components/ui/primitives";
import type { Article } from "@/src/lib/services/content";
import { ScrollReveal } from "@/src/components/motion/ScrollReveal";

/**
 * Honest content lists (Phase 11H): published, approved-copy articles only.
 * Empty => exactly that — no placeholder articles are ever synthesized.
 */
export function ArticleList({
  title,
  subtitle,
  emptyMessage,
  articles,
  locale,
}: {
  title: string;
  subtitle: string;
  emptyMessage: string;
  articles: Article[];
  locale: "en" | "bn";
}) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <SectionHeading title={title} subtitle={subtitle} />
      <ScrollReveal className="mt-8 grid gap-4" animateChildren>
        {articles.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          articles.map((a) => (
            <article key={a.id}>
              <Card className="p-6">
                <h2 className="text-lg font-bold text-ink-900">{locale === "bn" && a.titleBn ? a.titleBn : a.title}</h2>
                {a.publishedAt ? (
                  <p className="mt-1 text-xs text-ink-500">{new Date(a.publishedAt).toLocaleDateString()}</p>
                ) : null}
                <div className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-ink-700">
                  {(locale === "bn" && a.bodyBn ? a.bodyBn : a.body) || ""}
                </div>
              </Card>
            </article>
          ))
        )}
      </ScrollReveal>
    </section>
  );
}
