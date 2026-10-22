import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { SignUpForm } from "@/src/components/donor/SignUpForm";
import { RegisterWizard } from "@/src/components/donor/RegisterWizard";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Become a donor",
  alternates: { canonical: "./" },
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getServerSession();
  const params = await searchParams;
  const { dict } = await getDictionary();
  const r = dict.register;

  // If already signed in and is a donor, go to profile
  if (session?.isDonor) redirect("/profile");

  // If already signed in but not a donor, complete registration wizard
  if (session) {
    return (
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <Card className="p-6 sm:p-8">
          <RegisterWizard dict={r} />
        </Card>
      </section>
    );
  }

  const next = typeof params.next === "string" && /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/.test(params.next)
    ? params.next
    : "/profile";

  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1fr_520px]">
      <header className="max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">{r.title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">{r.subtitle}</p>
      </header>
      <Card className="p-6 sm:p-8 lg:justify-self-end">
        {session ? (
          <RegisterWizard dict={r} />
        ) : (
          <SignUpForm
            next={next}
            labels={{
              socialDivider: dict.auth.socialDivider,
              socialGoogle: dict.auth.socialGoogle,
              socialFacebook: dict.auth.socialFacebook,
              socialApple: dict.auth.socialApple,
            }}
          />
        )}
      </Card>
    </section>
  );
}
