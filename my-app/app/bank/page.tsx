import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDictionary } from "@/src/lib/i18n/server";
import { getServerSession } from "@/src/lib/session";
import { listMyBanks } from "@/src/lib/services/orgstock";
import { BankStockPanel } from "@/src/components/donor/BankStockPanel";
import { Alert, Badge, Card } from "@/src/components/ui/primitives";

export const metadata: Metadata = {
  title: "Bank management",
  alternates: { canonical: "./" },
};

export const dynamic = "force-dynamic";

export default async function BankPage() {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/bank");

  const { dict } = await getDictionary();
  const b = dict.bank;

  const result = await listMyBanks(session.id);
  const banks = result.ok ? result.data : [];

  return (
    <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{b.title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{b.subtitle}</p>
      </header>

      {!result.ok ? (
        <Alert tone="error" title={b.errors.heading}>
          <span>{result.message}</span>
        </Alert>
      ) : banks.length === 0 ? (
        <Card className="p-6">
          <h2 className="text-lg font-bold text-ink-900">{b.noneTitle}</h2>
          <p className="mt-2 text-[15px] text-ink-600">{b.noneBody}</p>
        </Card>
      ) : (
        <div className="grid gap-6">
          {banks.map((bank) => (
            <Card key={bank.bankId} className="p-6">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-bold text-ink-900">{bank.name}</h2>
                <Badge tone={bank.role === "admin" ? "brand" : "neutral"}>{bank.role}</Badge>
              </div>
              <p className="mt-1 text-sm text-ink-600">{bank.address}</p>
              <BankStockPanel
                key={bank.bankId}
                dict={dict}
                bankId={bank.bankId}
                bankName={bank.name}
              />
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
