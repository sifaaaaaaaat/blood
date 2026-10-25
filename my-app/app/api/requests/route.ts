import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { createRequest, listOwnRequests } from "@/src/lib/services/requests";
import { createMatchesFromCandidates } from "@/src/lib/services/matching";
import { fanOutMatchesForRequest } from "@/src/lib/services/fanout";
import { processOutbox } from "@/src/lib/services/notifications";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

export async function POST(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "request body must be JSON" }, { status: 400 });
  }
  const result = await createRequest(auth, body);
  if (!result.ok) {
    const status =
      result.code === "validation_error" ? 400 :
      result.code === "rate_limited" ? 429 : 500;
    return NextResponse.json(result, { status });
  }

  // -----------------------------------------------------------------------
  // Automatic outreach (Phase 12 fix): the request alone used to sit there
  // until the requester noticed the separate "Find & notify donors" button,
  // so nothing was ever sent. Now the submitted request immediately runs the
  // matching engine, fans out notifications to every pending match and
  // sweeps the outbox in-request — same server-authoritative, idempotent
  // steps the manual trigger uses. Every step is idempotent, so this also
  // heals requests whose earlier outreach failed. An outreach glitch
  // NEVER fails the request itself — the manual button remains the fallback.
  // -----------------------------------------------------------------------
  let outreach: unknown = null;
  const requestId = (result.data as { id?: string }).id;
  if (typeof requestId === "string" && requestId) {
    try {
      const matched = await createMatchesFromCandidates(auth, requestId);
      if (matched.ok) {
        const fanned = await fanOutMatchesForRequest(auth, requestId);
        const swept = await processOutbox();
        outreach = {
          matched: matched.ok ? matched.data : null,
          fanout: fanned.ok ? fanned.data : null,
          sweep: swept.ok ? swept.data : null,
          fanoutError: fanned.ok ? null : fanned.code,
          sweepError: swept.ok ? null : swept.code,
        };
      } else {
        outreach = { matchedError: matched.code };
      }
    } catch (e) {
      outreach = { outreachError: e instanceof Error ? e.message : "unknown" };
    }
  }

  return NextResponse.json(
    { ok: true, data: result.data, outreach, existing: (result as { existing?: boolean }).existing ?? false },
    { status: (result as { existing?: boolean }).existing ? 200 : 201 }
  );
}

export async function GET(req: NextRequest) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await listOwnRequests(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
