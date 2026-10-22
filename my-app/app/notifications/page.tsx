import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { listOwnMatches } from "@/src/lib/services/matching";
import { DonorMatchList } from "@/src/components/donor/DonorMatchList";
import { Alert, Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Notifications",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/notifications");

  const { dict } = await getDictionary();
  const r = dict.requests;
  const n = dict.notifications;

  // In-app donor surface: the donor's OWN matches (RLS-scoped) with real
  // accept/decline actions. SMS delivery is currently the mock provider
  // (honest, phase 7 note) — the in-app list is therefore the reliable path.
  const result = session.isDonor ? await listOwnMatches(session) : { ok: true as const, data: [] };
  const matches = result.ok ? result.data : [];

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{n.title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{n.subtitle}</p>
      </header>

      {!session.isDonor ? (
        <Card className="p-6">
          <p className="text-[15px] text-ink-600">{n.notDonor}</p>
        </Card>
      ) : (
        <div className="grid gap-6">
          {matches.length === 0 ? (
            <Card className="p-6">
              <p className="text-[15px] text-ink-600">{n.matchesEmpty}</p>
            </Card>
          ) : (
            <DonorMatchList dict={dict} matches={matches as unknown as Record<string, unknown>[]} />
          )}
          {result.ok ? null : (
            <Alert tone="error" title={r.errors.heading}>
              <span>{result.message}</span>
            </Alert>
          )}
          <Card className="p-5">
            <p className="text-sm text-ink-600">{n.deliveryNote}</p>
          </Card>
        </div>
      )}
    </section>
  );
}
