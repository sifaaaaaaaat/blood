import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { SectionHeading, Card } from "@/src/components/ui/primitives";
import { ContactForm } from "@/src/components/donor/ContactForm";

export const metadata: Metadata = { title: "About & contact", alternates: { canonical: "./" } };

export default async function ContactPage() {
  const { dict } = await getDictionary();
  const c = dict.contact;

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <SectionHeading title={c.title} subtitle={c.subtitle} />
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <p className="text-[15px] leading-relaxed text-ink-700">{c.body}</p>
          <p className="mt-4 text-sm text-ink-500">{c.reachNote}</p>
        </Card>
        <Card className="p-6">
          <h2 className="text-base font-bold text-ink-900">{c.formTitle}</h2>
          <div className="mt-4">
            <ContactForm dict={dict} />
          </div>
        </Card>
      </div>
    </section>
  );
}
