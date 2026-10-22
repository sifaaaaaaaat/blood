import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { getOwnRequest, listRequestTransitions } from "@/src/lib/services/requests";
import { listRequestMatches } from "@/src/lib/services/matching";
import { RequestDetail } from "@/src/components/donor/RequestDetail";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Your request",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/requests");

  const { id } = await params;
  const { dict } = await getDictionary();
  const r = dict.requests;

  const result = await getOwnRequest(session, id);
  if (!result.ok) {
    return (
      <section className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
        <Card className="p-6 text-center">
          <h1 className="text-2xl font-bold text-ink-900">{r.detail.notFoundTitle}</h1>
          <p className="mt-3 text-[15px] text-ink-600">{r.detail.notFoundBody}</p>
          <Link href="/requests" className="mt-4 inline-block text-sm font-semibold text-red-700 underline hover:no-underline">
            {r.detail.backToList}
          </Link>
        </Card>
      </section>
    );
  }

  const ownerReq = result.data as Record<string, unknown>;

  // The owner matches + history (both authorize inside; owner or admin).
  const [matchesRes, historyRes] = await Promise.all([
    listRequestMatches(session, id),
    listRequestTransitions(session, id),
  ]);

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <RequestDetail
        dict={dict}
        request={ownerReq}
        matches={matchesRes.ok ? (matchesRes.data as unknown as Record<string, unknown>[]) : []}
        history={historyRes.ok ? (historyRes.data as unknown as Record<string, unknown>[]) : []}
      />
    </section>
  );
}
