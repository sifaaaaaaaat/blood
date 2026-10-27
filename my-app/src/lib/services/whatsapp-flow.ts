import "server-only";
import {
  parseDonorChoice,
  composeDonationGapQuestion,
  composeDonorConfirmed,
  composeDonorDeclined,
  composeDonorInRestPeriod,
  composeNotActionable,
  composeUnclearReply,
  type RequestMessageContext,
} from "@/src/lib/services/whatsapp-messages";

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const err = (code: string, message: string): Result<never> => ({ ok: false, code, message });

/**
 * The WhatsApp donor conversation (free whatsapp-web.js bridge).
 *
 * Security model: an inbound reply is authorized by the SENDER'S OWN NUMBER.
 * The webhook resolves that number to a profile, and only the match rows bound
 * to that profile can be acted on — a donor can never answer for someone else,
 * and an unknown number gets no information back.
 *
 * Stage machine (one row per match in whatsapp_match_sessions):
 *   awaiting_accept        → "1" accept  → awaiting_donation_gap (ask the 3-month question)
 *                          → "2" ignore  → done
 *   awaiting_donation_gap  → "2" (not donated in 3 months) → done, match stays accepted
 *                          → "1" (donated recently)       → done, donor paused 3 months,
 *                                                           match released to unavailable
 *   done                   → later replies are acknowledged, never re-acted on.
 *
 * The database stays authoritative: every transition runs through the same
 * security-definer RPCs the in-app flow uses, and the outbox sweep is asked to
 * run again so the requester/side-effects keep flowing.
 */

type DbError = { message: string } | null;
type Row = Record<string, unknown>;

/** Mirrors PostgrestFilterBuilder: chainable AND awaitable at any point. */
interface SelectChain extends PromiseLike<{ data: unknown; error: DbError }> {
  eq(col: string, val: unknown): SelectChain;
  in(col: string, vals: unknown[]): SelectChain;
  neq(col: string, val: unknown): SelectChain;
  order(col: string, opts?: { ascending?: boolean }): SelectChain;
  limit(n: number): SelectChain;
  maybeSingle(): PromiseLike<{ data: unknown; error: DbError }>;
}
interface UpdateChain {
  eq(col: string, val: unknown): PromiseLike<{ error: DbError }>;
}
interface TableRef {
  select(cols: string): SelectChain;
  update(row: Record<string, unknown>): UpdateChain;
}
interface SupabaseLike {
  from(t: string): TableRef;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError }>;
}

async function getService(): Promise<SupabaseLike> {
  const { getServiceRoleClient } = await import("@/src/lib/db");
  return getServiceRoleClient() as unknown as SupabaseLike;
}

/** Digits-only international form → E.164 used by contact_numbers. */
export function toE164(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!/^[0-9]{8,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/** Requests in these states are still open for donor replies. */
const OPEN_REQUEST_STATUSES = ["submitted", "searching", "awaiting_responses"];

/**
 * Every account reachable on this number, newest-registration last.
 *
 * A single phone CAN legitimately belong to more than one account (the same
 * person registering twice), so this must never use maybeSingle(): PostgREST
 * errors when more than one row matches, which silently dropped every reply
 * from a shared number. Callers pick the account with an open conversation.
 */
export async function resolveDonorsByPhone(e164: string): Promise<string[]> {
  const svc = await getService();

  const collect = async (column: "phone_normalized" | "phone"): Promise<string[]> => {
    const { data } = await svc
      .from("contact_numbers")
      .select("user_id, created_at")
      .eq(column, e164)
      .order("created_at", { ascending: true })
      .limit(5);
    const rows = (Array.isArray(data) ? data : []) as Row[];
    return rows.map((r) => (r.user_id ? String(r.user_id) : "")).filter(Boolean);
  };

  const byNormalized = await collect("phone_normalized");
  // Fallback for rows saved before normalization existed.
  const byRaw = byNormalized.length ? [] : await collect("phone");
  return [...new Set([...byNormalized, ...byRaw])];
}

/** Request facts the donor message needs (never personal data). */
export async function fetchRequestMessageContext(
  requestId: string
): Promise<(RequestMessageContext & { status: string }) | null> {
  const svc = await getService();
  const { data } = await svc
    .from("blood_requests")
    .select("blood_group, units_needed, location_text, urgency, status, location_id")
    .eq("id", requestId)
    .maybeSingle();
  const req = data as Row | null;
  if (!req) return null;

  let upazilaName: string | null = null;
  let districtName: string | null = null;
  const locationId = req.location_id;
  if (typeof locationId === "number" || typeof locationId === "string") {
    const up = await svc.from("upazilas").select("name, district_id").eq("id", locationId).maybeSingle();
    const upRow = up.data as Row | null;
    upazilaName = upRow?.name ? String(upRow.name) : null;
    if (upRow?.district_id != null) {
      const di = await svc.from("districts").select("name").eq("id", upRow.district_id).maybeSingle();
      const diRow = di.data as Row | null;
      districtName = diRow?.name ? String(diRow.name) : null;
    }
  }

  return {
    bloodGroup: String(req.blood_group ?? ""),
    unitsNeeded: Number(req.units_needed ?? 1),
    locationText: req.location_text ? String(req.location_text) : null,
    upazilaName,
    districtName,
    urgency: String(req.urgency ?? "routine"),
    status: String(req.status ?? ""),
  };
}

type SessionRow = { match_id: string; stage: string; created_at: string };
type MatchRow = { id: string; request_id: string; status: string; expires_at: string };

/** Newest open conversation for this donor (stage != done, match still live). */
async function findOpenConversation(
  svc: SupabaseLike,
  donorId: string
): Promise<{ session: SessionRow; match: MatchRow } | null> {
  const { data: sessionsData } = await svc
    .from("whatsapp_match_sessions")
    .select("match_id, stage, created_at")
    .eq("donor_id", donorId)
    .neq("stage", "done")
    .order("created_at", { ascending: false })
    .limit(5);
  const sessions = (Array.isArray(sessionsData) ? sessionsData : []) as SessionRow[];
  if (!sessions.length) return null;

  const { data: matchData } = await svc
    .from("request_matches")
    .select("id, request_id, status, expires_at")
    .eq("donor_id", donorId)
    .in("status", ["pending", "notified", "accepted"]);
  const matches = (Array.isArray(matchData) ? matchData : []) as MatchRow[];

  for (const session of sessions) {
    const match = matches.find((m) => m.id === session.match_id);
    if (!match) continue;
    if (new Date(match.expires_at) < new Date()) continue;
    // The stage must match the row's state, otherwise the conversation is stale.
    if (session.stage === "awaiting_accept" && !["pending", "notified"].includes(match.status)) continue;
    if (session.stage === "awaiting_donation_gap" && match.status !== "accepted") continue;
    return { session, match };
  }
  return null;
}

async function requestIsOpen(svc: SupabaseLike, requestId: string): Promise<boolean> {
  const { data } = await svc.from("blood_requests").select("status").eq("id", requestId).maybeSingle();
  const row = data as Row | null;
  return row ? OPEN_REQUEST_STATUSES.includes(String(row.status)) : false;
}

async function setStage(svc: SupabaseLike, matchId: string, stage: string): Promise<void> {
  await svc
    .from("whatsapp_match_sessions")
    .update({ stage, updated_at: new Date().toISOString() })
    .eq("match_id", matchId);
}

/**
 * Handle one inbound donor message. Returns the replies the bridge should send
 * back (empty = stay silent).
 */
export async function handleDonorWhatsAppReply(
  rawPhone: string,
  rawText: string
): Promise<Result<{ handled: boolean; replies: string[]; donorId: string | null }>> {
  const e164 = toE164(rawPhone);
  if (!e164) return err("validation_error", "unrecognized sender number");

  const choice = parseDonorChoice(rawText);
  const svc = await getService();

  const candidateDonors = await resolveDonorsByPhone(e164);
  // Unknown sender: never disclose anything, not even that the number is unused.
  if (!candidateDonors.length) return { ok: true, data: { handled: false, replies: [], donorId: null } };

  // The number may belong to several accounts; the reply belongs to whichever
  // account actually holds an open conversation with this number.
  let donorId = candidateDonors[0];
  let conversation: { session: SessionRow; match: MatchRow } | null = null;
  for (const candidate of candidateDonors) {
    const found = await findOpenConversation(svc, candidate);
    if (found) {
      donorId = candidate;
      conversation = found;
      break;
    }
  }

  if (!conversation) {
    // Known donor, nothing pending: acknowledge only if they clearly answered.
    return {
      ok: true,
      data: {
        handled: false,
        replies: choice ? [composeNotActionable("the request already closed or was answered")] : [],
        donorId,
      },
    };
  }

  if (!choice) {
    return { ok: true, data: { handled: true, replies: [composeUnclearReply()], donorId } };
  }

  const { session, match } = conversation;

  // The request must still be live (cancelled/fulfilled stop coordination).
  if (!(await requestIsOpen(svc, match.request_id))) {
    await setStage(svc, match.id, "done");
    return {
      ok: true,
      data: { handled: true, replies: [composeNotActionable("the request is closed")], donorId },
    };
  }

  if (session.stage === "awaiting_accept") {
    if (choice === "two") {
      const res = await svc.rpc("donor_respond_match", {
        p_match_id: match.id,
        p_action: "decline",
        p_donor: donorId,
        p_source: "whatsapp",
      });
      await setStage(svc, match.id, "done");
      const row = firstRow(res.data);
      if (!res.error && row?.ok) {
        return { ok: true, data: { handled: true, replies: [composeDonorDeclined()], donorId } };
      }
      return {
        ok: true,
        data: { handled: true, replies: [composeNotActionable(rowMessage(row))], donorId },
      };
    }

    const res = await svc.rpc("donor_respond_match", {
      p_match_id: match.id,
      p_action: "accept",
      p_donor: donorId,
      p_source: "whatsapp",
    });
    const row = firstRow(res.data);
    if (res.error || !row?.ok) {
      await setStage(svc, match.id, "done");
      return {
        ok: true,
        data: { handled: true, replies: [composeNotActionable(rowMessage(row))], donorId },
      };
    }
    await setStage(svc, match.id, "awaiting_donation_gap");
    return {
      ok: true,
      data: { handled: true, replies: [composeDonationGapQuestion()], donorId },
    };
  }

  // stage === awaiting_donation_gap → the 3-month question
  if (choice === "two") {
    // Has NOT donated recently: the acceptance stands and the requester may
    // now reveal this donor's number.
    await setStage(svc, match.id, "done");
    const ctx = await fetchRequestMessageContext(match.request_id);
    return {
      ok: true,
      data: {
        handled: true,
        replies: [composeDonorConfirmed({ bloodGroup: ctx?.bloodGroup ?? "blood" })],
        donorId,
      },
    };
  }

  // Donated within 3 months: record it, pause the donor, release the match so
  // the requester is never handed a contact who cannot donate.
  const declared = await svc.rpc("whatsapp_declare_recent_donation", { p_donor: donorId });
  const released = await svc.rpc("whatsapp_release_match_after_ineligible", {
    p_match_id: match.id,
    p_donor: donorId,
  });
  if (released.error) return err("db_error", released.error.message);

  const declaredRow = firstRow(declared.data);
  await setStage(svc, match.id, "done");

  const pausedUntil = declaredRow?.paused_until ? String(declaredRow.paused_until) : null;
  return {
    ok: true,
    data: { handled: true, replies: [composeDonorInRestPeriod(pausedUntil)], donorId },
  };
}

function firstRow(data: unknown): Row | null {
  const row = Array.isArray(data) ? (data[0] as Row | undefined) : (data as Row | null);
  return row ?? null;
}

function rowMessage(row: Row | null): string | null {
  const message = row?.message;
  return typeof message === "string" ? message : null;
}
