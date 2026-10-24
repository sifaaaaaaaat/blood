import type { Metadata } from "next";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { ResetPasswordForm } from "@/src/components/auth/ResetPasswordForm";
import { ForgotPasswordForm } from "@/src/components/auth/ForgotPasswordForm";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Set a new password",
  alternates: { canonical: "./" },
  robots: { index: false },
};
export const dynamic = "force-dynamic";

/**
 * The one-time recovery link redirects through /api/auth/callback (PKCE),
 * which establishes the recovery session — THIS page then shows the
 * new-password form. Without a session (opened later / reused link) we show
 * the request-a-new-link flow instead. No enumeration signal either way.
 */
export default async function ResetPage() {
  const { dict } = await getDictionary();
  const labels = dict.auth;
  const session = await getServerSession();

  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1fr_460px]">
      <header className="max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
          {session ? labels.resetTitle : labels.forgotTitle}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">
          {session ? labels.resetSubtitle : labels.resetNoSession}
        </p>
      </header>
      <Card className="p-6 sm:p-8 lg:justify-self-end">
        {session ? (
          <ResetPasswordForm
            labels={{
              resetSubmit: labels.resetSubmit,
              resetSaving: labels.resetSaving,
              resetDone: labels.resetDone,
              passwordLabel: labels.passwordLabel,
              passwordPlaceholder: labels.passwordPlaceholder,
            }}
          />
        ) : (
          <ForgotPasswordForm
            labels={{
              forgotSubmit: labels.forgotSubmit,
              forgotSending: labels.forgotSending,
              forgotSent: labels.forgotSent,
              forgotError: labels.forgotError,
              signInError: labels.signInError,
            }}
          />
        )}
      </Card>
    </section>
  );
}
