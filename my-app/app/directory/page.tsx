import type { Metadata } from "next";
import Link from "next/link";
import { bankFilterSchema, BANK_KINDS, BLOOD_GROUPS } from "@/src/lib/validation/directory";
import {
  listDivisionOptions,
  listDistrictOptions,
  listPublishedBanks,
  type BloodBankCard,
  type LocationOption,
} from "@/src/lib/services/bloodbanks";
import { getDictionary } from "@/src/lib/i18n/server";
import type { Dictionary } from "@/src/lib/i18n/dictionaries";
import { ScrollReveal } from "@/src/components/motion/ScrollReveal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getDictionary();
  return {
    title: locale === "bn" ? "ব্লাড ব্যাংক ডিরেক্টরি — রক্তসাথী" : "Blood bank directory — RoktoSathi",
    alternates: { canonical: "./" },
  };
}

type PageProps = { searchParams: Promise<Record<string, string | undefined>> };

const INPUT_CLASS =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[15px] text-ink-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100";
const LABEL_CLASS = "mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-500";

export default async function DirectoryPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const { locale, dict } = await getDictionary();
  const d = dict.directory;

  const parsed = bankFilterSchema.safeParse({
    divisionId: sp["division"] || undefined,
    districtId: sp["district"] || undefined,
    group: sp["group"] || undefined,
    kind: sp["kind"] || undefined,
    q: sp["q"] || undefined,
    limit: sp["limit"] || undefined,
    offset: sp["offset"] || undefined,
  });
  const filter = parsed.success ? parsed.data : bankFilterSchema.parse({});

  const hasActiveFilters =
    filter.divisionId !== undefined || filter.districtId !== undefined ||
    filter.group !== undefined || filter.kind !== undefined || filter.q !== undefined;

  const [banksResult, divisionsResult] = await Promise.all([
    listPublishedBanks(filter),
    listDivisionOptions(),
  ]);
  const districtsResult = filter.divisionId !== undefined
    ? await listDistrictOptions(filter.divisionId)
    : null;

  const banks = banksResult.ok ? banksResult.data : ([] as BloodBankCard[]);
  const divisions = divisionsResult.ok ? divisionsResult.data : ([] as LocationOption[]);
  const districts = districtsResult?.ok ? districtsResult.data : ([] as LocationOption[]);
  const dbHealthy = banksResult.ok && divisionsResult.ok;

  const resultsLabel = banks.length === 1 ? d.resultsOne : d.resultsMany.replace("{n}", String(banks.length));
  const kindLabel = (k: string) =>
    d.kinds[k as keyof typeof d.kinds] ?? k;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink-900 sm:text-4xl">{d.title}</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-600">{d.body}</p>
          </div>
          <Link
            href="/directory/new"
            className="inline-flex h-10 shrink-0 items-center rounded-lg border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100"
          >
            {d.addBankCta}
          </Link>
        </div>
      </header>

      {/* Filters: a plain GET form — every control performs a REAL server-side
          query on the platform's own blood_banks table. No local-only state. */}
      <form method="get" action="/directory" className="mt-8 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="f-division" className={LABEL_CLASS}>{d.filters.division}</label>
            <select
              id="f-division"
              name="division"
              defaultValue={filter.divisionId ?? ""}
              className={INPUT_CLASS}
            >
              <option value="">{d.filters.any}</option>
              {divisions.map((div) => (
                <option key={div.id} value={div.id}>
                  {locale === "bn" ? div.nameBn : div.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-district" className={LABEL_CLASS}>{d.filters.district}</label>
            <select
              id="f-district"
              name="district"
              defaultValue={filter.districtId ?? ""}
              className={INPUT_CLASS}
              disabled={filter.divisionId === undefined}
            >
              <option value="">{d.filters.any}</option>
              {districts.map((dis) => (
                <option key={dis.id} value={dis.id}>
                  {locale === "bn" ? dis.nameBn : dis.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-group" className={LABEL_CLASS}>{d.filters.group}</label>
            <select id="f-group" name="group" defaultValue={filter.group ?? ""} className={INPUT_CLASS}>
              <option value="">{d.filters.any}</option>
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-kind" className={LABEL_CLASS}>{d.filters.kind}</label>
            <select id="f-kind" name="kind" defaultValue={filter.kind ?? ""} className={INPUT_CLASS}>
              <option value="">{d.filters.any}</option>
              {BANK_KINDS.map((k) => (
                <option key={k} value={k}>{d.kinds[k]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label htmlFor="f-q" className={LABEL_CLASS}>{d.filters.search}</label>
            <input
              id="f-q"
              type="search"
              name="q"
              defaultValue={filter.q ?? ""}
              maxLength={80}
              placeholder={d.filters.search}
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="inline-flex h-10 items-center justify-center rounded-lg bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800"
            >
              {d.filters.apply}
            </button>
            {hasActiveFilters && (
              <Link
                href="/directory"
                className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-100"
              >
                {d.clearFilters}
              </Link>
            )}
          </div>
        </div>
      </form>

      {/* Result count + stock note */}
      {dbHealthy ? (
        <p className="mt-6 text-sm font-medium text-ink-700" role="status">
          {hasActiveFilters || banks.length > 0 ? resultsLabel : ""}
        </p>
      ) : (
        <p className="mt-6 text-sm text-ink-700">{dict.stats.pending}</p>
      )}

      {/* Results / honest empty states */}
      <section aria-live="polite" className="mt-4">
        {banks.length > 0 ? (
          <ScrollReveal as="ul" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" animateChildren>
            {banks.map((bank) => (
              <BankCard key={bank.id} bank={bank} dict={d} locale={locale} kindLabel={kindLabel} />
            ))}
          </ScrollReveal>
        ) : (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white p-8 text-center">
            <p className="mx-auto max-w-xl text-[15px] leading-relaxed text-ink-600">
              {hasActiveFilters ? d.emptyFiltered : dbHealthy ? d.empty : dict.stats.pending}
            </p>
            {hasActiveFilters && (
              <Link
                href="/directory"
                className="mt-4 inline-flex h-10 items-center rounded-lg border border-ink-300 px-4 text-sm font-medium text-ink-800 transition-colors hover:bg-ink-100"
              >
                {d.clearFilters}
              </Link>
            )}
          </div>
        )}
        {dbHealthy && (
          <p className="mt-6 text-xs text-ink-500">{d.stockNote}</p>
        )}
      </section>
    </main>
  );
}

function BankCard({
  bank,
  dict,
  locale,
  kindLabel,
}: {
  bank: BloodBankCard;
  dict: Dictionary["directory"];
  locale: string;
  kindLabel: (k: string) => string;
}) {
  const name = locale === "bn" && bank.nameBn ? bank.nameBn : bank.name;
  const areaParts = [
    locale === "bn" ? bank.upazilaNameBn || bank.upazilaName : bank.upazilaName,
    locale === "bn" ? bank.districtNameBn || bank.districtName : bank.districtName,
    locale === "bn" ? bank.divisionNameBn || bank.divisionName : bank.divisionName,
  ].filter(Boolean) as string[];
  const areaLine = areaParts.join(", ");
  const publishedDate = bank.publishedAt
    ? new Intl.DateTimeFormat(locale === "bn" ? "bn-BD" : "en-GB", { dateStyle: "long" }).format(
        new Date(bank.publishedAt)
      )
    : null;

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-bold text-ink-900">{name}</h2>
        <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-red-700">{kindLabel(bank.kind)}</p>
      </div>
      <p className="text-[15px] leading-relaxed text-ink-700">{bank.address}</p>
      {areaLine && <p className="text-xs text-ink-500">{dict.card.area}: {areaLine}</p>}
      <dl className="grid gap-1.5 text-[13px] text-ink-700">
        {bank.phonePublic && (
          <div className="flex gap-2">
            <dt className="shrink-0 font-semibold">{dict.card.phone}:</dt>
            <dd>
              <a href={`tel:${bank.phonePublic}`} className="underline hover:text-red-700">{bank.phonePublic}</a>
            </dd>
          </div>
        )}
        {bank.openingHours && (
          <div className="flex gap-2">
            <dt className="shrink-0 font-semibold">{dict.card.hours}:</dt>
            <dd>{bank.openingHours}</dd>
          </div>
        )}
      </dl>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{dict.card.groups}</p>
        {bank.groupsAtIssue.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {bank.groupsAtIssue.map((g) => (
              <li key={g} className="rounded-md bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-100">
                {g}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs italic text-ink-400">{dict.card.groupsUnknown}</p>
        )}
      </div>
      {bank.stock && bank.stock.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{dict.card.stock}</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {bank.stock.map((s) => (
              <li key={s.group} className="rounded-md bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700 ring-1 ring-teal-100">
                {s.group}: {s.units}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-400">{dict.card.stockSource}</p>
        </div>
      ) : null}
      <footer className="mt-auto border-t border-ink-100 pt-3 text-xs text-ink-500">
        <p>
          {dict.card.source}: {bank.sourceNote}
        </p>
        {publishedDate && <p className="mt-0.5">{dict.card.published}: {publishedDate}</p>}
      </footer>
    </li>
  );
}
