import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { ForgotPasswordForm } from "@/src/components/auth/ForgotPasswordForm";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Reset your password",
  alternates: { canonical: "./" },
};
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const { dict } = await getDictionary();
  const labels = dict.auth;

  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1fr_460px]">
      <header className="max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
          {labels.forgotTitle}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">{labels.forgotSubtitle}</p>
      </header>
      <Card className="p-6 sm:p-8 lg:justify-self-end">
        <ForgotPasswordForm
          labels={{
            forgotSubmit: labels.forgotSubmit,
            forgotSending: labels.forgotSending,
            forgotSent: labels.forgotSent,
            forgotError: labels.forgotError,
            signInError: labels.signInError,
          }}
        />
      </Card>
    </section>
  );
}
