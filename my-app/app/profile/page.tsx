import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { getOwnDonorProfile } from "@/src/lib/services/donors";
import { ProfileEditor } from "@/src/components/donor/ProfileEditor";
import { Badge, ButtonLink, Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Your profile",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/profile");

  const { dict } = await getDictionary();
  const p = dict.profile;

  // Signed in with no donor row yet → honest prompt, real CTA. Registration
  // lives on its own gated page; nothing here is faked.
  if (!session.isDonor) {
    return (
      <section className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
        <Card className="p-6 sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">{p.notRegisteredTitle}</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-ink-600">{p.notRegisteredBody}</p>
          <ButtonLink href="/register" className="mt-6">
            {p.notRegisteredCta}
          </ButtonLink>
        </Card>
      </section>
    );
  }

  // Registered → load the owner's own profile (owner-side fields included).
  // The session client here is bound to this user's cookies, so RLS guarantees
  // this can only ever read their own row.
  const result = await getOwnDonorProfile(session);

  return (
    <section className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{p.title}</h1>
            <Badge tone="brand">{p.registeredBadge}</Badge>
          </div>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{p.subtitle}</p>
        </div>
      </header>
      {result.ok ? (
        <ProfileEditor initial={result.data} dict={dict} />
      ) : (
        <Card className="p-6">
          <p className="text-[15px] text-ink-600">{p.notRegisteredBody}</p>
          <Link href="/register" className="mt-3 inline-block text-sm font-semibold text-red-700 underline hover:no-underline">
            {p.notRegisteredCta}
          </Link>
        </Card>
      )}
    </section>
  );
}
