import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { RequestForm } from "@/src/components/donor/RequestForm";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Request blood",
  alternates: { canonical: "./" },
};

export default async function NewRequestPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/requests/new");

  const { dict } = await getDictionary();
  const r = dict.requests;

  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1fr_560px]">
      <header className="max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">{r.newTitle}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">{r.newSubtitle}</p>
      </header>
      <Card className="p-6 sm:p-8">
        <RequestForm dict={dict} />
      </Card>
    </section>
  );
}
