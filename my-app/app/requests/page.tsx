import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { listOwnRequests } from "@/src/lib/services/requests";
import { Badge, ButtonLink, Card } from "@/src/components/ui/primitives";
import { ScrollReveal } from "@/src/components/motion/ScrollReveal";

export const metadata: Metadata = {
  title: "Your blood requests",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

const TONE: Record<string, "neutral" | "brand" | "warning"> = {
  submitted: "neutral",
  searching: "brand",
  awaiting_responses: "brand",
  connected: "brand",
  fulfilled: "warning",
  cancelled: "neutral",
  expired: "neutral",
  flagged: "warning",
  draft: "neutral",
};

export default async function RequestsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/requests");

  const { dict } = await getDictionary();
  const r = dict.requests;
  const result = await listOwnRequests(session);
  const rows = (result.ok ? result.data : []) as Record<string, unknown>[];

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{r.listTitle}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{r.listSubtitle}</p>
        </div>
        <ButtonLink href="/requests/new" size="sm">
          {r.newRequestCta}
        </ButtonLink>
      </header>

      {rows.length === 0 ? (
        <Card className="p-6">
          <p className="text-[15px] text-ink-600">{r.listEmpty}</p>
          <Link href="/requests/new" className="mt-3 inline-block text-sm font-semibold text-red-700 underline hover:no-underline">
            {r.newRequestCta}
          </Link>
        </Card>
      ) : (
        <ScrollReveal as="ul" className="grid gap-3" animateChildren>
          {rows.map((row) => {
            const id = String(row.id);
            const status = String(row.status);
            return (
              <li key={id}>
                <Card className="flex flex-wrap items-center gap-4 p-4">
                  <Badge tone={TONE[status] ?? "neutral"}>{r.status[status as keyof typeof r.status]}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-ink-900">{String(row.hospital_name)}</p>
                    <p className="text-sm text-ink-600">
                      {row.blood_group as string} · {row.units_needed as number} {r.detail.units} ·{" "}
                      {new Date(String(row.required_by)).toLocaleString()}
                    </p>
                  </div>
                  <Link href={`/requests/${id}`} className="text-sm font-semibold text-red-700 underline hover:no-underline">
                    {r.view}
                  </Link>
                </Card>
              </li>
            );
          })}
        </ScrollReveal>
      )}
    </section>
  );
}
