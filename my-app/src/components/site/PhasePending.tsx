import Link from "next/link";
import { Badge, Card } from "@/src/components/ui/primitives";

/**
 * Honest pending-state page for nav destinations whose workflows ship in a
 * later Phase 11 package. It states the phase, explains why nothing is faked,
 * and always gives the user a way back — never a dead end.
 */
export function PhasePending({
  phase,
  description,
  backLabel,
  pendingHeading,
  pendingBody,
  phaseLabel,
}: {
  phase: string;
  description: string;
  backLabel: string;
  pendingHeading: string;
  pendingBody: string;
  phaseLabel: string;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-20 text-center sm:px-6">
      <Card className="w-full p-8 sm:p-10">
        <Badge tone="brand">{`${phaseLabel} ${phase}`}</Badge>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink-900">{pendingHeading}</h1>
        <p className="mx-auto mt-3 max-w-lg text-[15px] leading-relaxed text-ink-600">
          {description}
        </p>
        <p className="mx-auto mt-6 max-w-lg border-t border-ink-100 pt-6 text-sm leading-relaxed text-ink-500">
          {pendingBody}
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-11 items-center justify-center rounded-lg bg-ink-100 px-5 text-[15px] font-semibold text-ink-800 transition-colors hover:bg-ink-200"
        >
          {backLabel}
        </Link>
      </Card>
    </div>
  );
}
