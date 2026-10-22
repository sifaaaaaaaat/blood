import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { SignInForm } from "@/src/components/donor/SignInForm";
import { Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Log in",
  alternates: { canonical: "./" },
};

/** Same-origin relative path someone wanted to land on after sign-in. */
const NEXT_RE = /^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const session = await getServerSession();
  const params = await searchParams;

  // Already signed in? Skip straight to where the user was heading.
  if (session) {
    redirect(NEXT_RE.test(params.next ?? "") ? (params.next as string) : "/profile");
  }

  const { dict } = await getDictionary();
  const labels = dict.auth;
  const next = NEXT_RE.test(params.next ?? "") ? (params.next as string) : "/profile";
  const callbackError = typeof params.error === "string" && params.error ? params.error : null;

  return (
    <section className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[1fr_460px]">
      <header className="max-w-xl">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">
          {labels.loginTitle}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-600">{labels.loginSubtitle}</p>
      </header>
      <Card className="p-6 sm:p-8 lg:justify-self-end">
        <SignInForm labels={labels} next={next} callbackError={callbackError} />
      </Card>
    </section>
  );
}
