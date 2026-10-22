import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { BankProposalForm } from "@/src/components/donor/BankProposalForm";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Propose a blood bank",
  alternates: { canonical: "./" },
};

/**
 * Signed-in self-service: propose a blood bank for the directory. Stored
 * unpublished; a moderator verifies then publishes it (Phase 11C provenance
 * rule is never bypassed — no row goes live without review).
 */
export default async function ProposeBankPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/directory/new");

  const { dict } = await getDictionary();
  const p = dict.directory.propose;

  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1fr_560px]">
      <header className="max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">{p.title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">{p.subtitle}</p>
        <Link href="/directory" className="mt-6 inline-flex text-sm font-semibold text-red-700 underline hover:no-underline">
          {p.backToDirectory}
        </Link>
      </header>
      <Card className="p-6 sm:p-8">
        <BankProposalForm dict={dict} />
      </Card>
    </section>
  );
}
