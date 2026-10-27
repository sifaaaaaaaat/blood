import "server-only";

/**
 * WhatsApp message copy for the donor conversation (Phase 7 / 0023).
 *
 * Formatting follows the reference designs the owner supplied: a titled block
 * with the need, the place, and a numbered "can you help?" ask. WhatsApp
 * renders *bold* and _italic_ markup and collapses blank lines.
 *
 * Hard rules:
 *   · Never claim a donor is medically eligible/ineligible — the 3-month
 *     question is a rest-period rule, phrased as the donor's own report.
 *   · Never put a phone number or personal data in a message body.
 *   · Never state that a message was delivered/received on the recipient's
 *     behalf (no fabricated delivery claims).
 *   · Body must stay under the bridge's 2000-character limit.
 */

/** Normalized choice from a donor's reply. Both questions use 1 = first option, 2 = second. */
export type DonorChoice = "one" | "two" | null;

// Bangla digits are NOT compatibility-decomposed by NFKC, so donors typing
// ১/২ are normalized explicitly before matching.
const BANGLA_DIGITS: Record<string, string> = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
const mapBanglaDigits = (s: string) => s.replace(/[০-৯]/g, (d) => BANGLA_DIGITS[d] ?? d);

const ONE_WORDS = new Set([
  "1", "one", "accept", "accepted", "yes", "y", "ok", "okay", "sure",
  "হ্যাঁ", "হা", "সম্মত", "আছি", "পারব",
]);
const TWO_WORDS = new Set([
  "2", "two", "ignore", "decline", "declined", "no", "n", "notnow",
  "later", "skip", "না", "পারব না", "পারবনা",
]);

/**
 * Interpret a donor's reply. Deliberately permissive (people type "Accept",
 * "yes", "1", or Bangla words) but never guesses on free text: anything
 * unrecognized returns null so the caller can re-ask instead of acting.
 */
export function parseDonorChoice(raw: string | null | undefined): DonorChoice {
  if (typeof raw !== "string") return null;
  const cleaned = mapBanglaDigits(raw)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    // Combining marks (\p{M}) must survive: Bangla words like হ্যাঁ carry a
    // virama/matra, and dropping them would break the match.
    .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
  if (!cleaned) return null;
  if (ONE_WORDS.has(cleaned)) return "one";
  if (TWO_WORDS.has(cleaned)) return "two";
  // Tolerate short sentences that start with the keyword ("1. yes please").
  const first = cleaned.split(" ")[0];
  if (ONE_WORDS.has(first)) return "one";
  if (TWO_WORDS.has(first)) return "two";
  return null;
}

export type RequestMessageContext = {
  bloodGroup: string;
  unitsNeeded: number;
  /** Hospital / landmark text the requester entered, if any. */
  locationText: string | null;
  upazilaName: string | null;
  districtName: string | null;
  urgency: string;
};

const URGENCY_WORD: Record<string, string> = {
  routine: "Routine",
  urgent: "Urgent",
  critical: "Critical — needed now",
};

/** Trim to a single readable line and never let user text break the layout. */
function line(value: string | null | undefined, max = 70): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The "blood request near you" ask (reference design 1). */
export function composeMatchAsk(ctx: RequestMessageContext): string {
  const where = [line(ctx.upazilaName, 40), line(ctx.districtName, 40)].filter(Boolean).join(", ");
  const lines = [
    "🩸 *Blood request near you*",
    "",
    `Blood group needed: *${ctx.bloodGroup}*`,
    `Units required: ${ctx.unitsNeeded}`,
  ];
  const hospital = line(ctx.locationText);
  if (hospital) lines.push(`Hospital/area: ${hospital}`);
  if (where) lines.push(`Location: ${where}`);
  lines.push(`Urgency: ${URGENCY_WORD[ctx.urgency] ?? ctx.urgency}`);
  lines.push("", "Can you help?", "", "Reply *1* to accept", "Reply *2* to ignore");
  return lines.join("\n");
}

/** The rest-period question (reference design 2). */
export function composeDonationGapQuestion(): string {
  return [
    "Thanks for accepting. 🙏",
    "",
    "*Have you donated blood in the last 3 months?*",
    "",
    "Reply *1* for Yes",
    "Reply *2* for No",
  ].join("\n");
}

/** Donor cleared the rest period: the requester may now be given their contact. */
export function composeDonorConfirmed(ctx: { bloodGroup: string }): string {
  return [
    "✅ *Thank you — you are confirmed.*",
    "",
    `Your number will be shared with the patient's requester for this ${ctx.bloodGroup} request so they can contact you directly.`,
    "",
    "Please keep your phone reachable. If your plans change, reply *2* to step back.",
  ].join("\n");
}

/** Donor is inside the 3-month rest period. */
export function composeDonorInRestPeriod(pausedUntil: string | null): string {
  return [
    "Thank you for being honest. 🙏",
    "",
    "Because you gave blood recently, you cannot donate again for three months — so we will *not* share your number for this request.",
    pausedUntil ? `You can be matched again after *${pausedUntil}*.` : null,
    "",
    "Your number stays private. We will only ask again after that date.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Donor declined the request. */
export function composeDonorDeclined(): string {
  return [
    "Understood — thanks for letting us know. 🙏",
    "",
    "We will not share your number for this request.",
  ].join("\n");
}

/** Ask could not be acted on (match already answered, expired, or enough donors found). */
export function composeNotActionable(reason: string | null): string {
  return [
    "This request is not open for a reply any more.",
    "",
    reason ? `Reason: ${line(reason, 120)}` : null,
    "No action is needed from you.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Reply was not understood. */
export function composeUnclearReply(): string {
  return "Sorry, I did not understand that. Please reply *1* or *2*.";
}

/** No open conversation for this number (avoids replying to random messages). */
export const SILENT = null;
