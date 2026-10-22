import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { ScheduleManager } from "@/src/components/donor/ScheduleManager";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Thalassemia & recurring requests",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

/**
 * Phase 11J — thalassemia / recurring blood request schedules.
 *
 * A schedule generates a DRAFT request on demand; nothing is ever sent
 * automatically. The owner reviews the draft and submits it through the
 * standard flow, so consent, caps and matching apply every single time.
 */
export default async function ThalassemiaPage() {
  const { dict } = await getDictionary();
  const t = dict.thalassemia;
  const session = await getServerSession();

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{t.title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{t.subtitle}</p>
      </header>

      <Card className="mb-8 p-6">
        <p className="text-[15px] leading-relaxed text-ink-600">{t.explain}</p>
      </Card>

      {!session ? (
        <Card className="p-6">
          <p className="text-[15px] text-ink-600">{t.loginNeeded}</p>
        </Card>
      ) : (
        <ScheduleManager
          dict={t}
          cascadeLabels={{
            division: dict.register.location.divisionLabel,
            district: dict.register.location.districtLabel,
            upazila: dict.requests.form.locationLabel,
          }}
        />
      )}
    </section>
  );
}
