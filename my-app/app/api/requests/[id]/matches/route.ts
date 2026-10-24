import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { createMatchesFromCandidates, listRequestMatches } from "@/src/lib/services/matching";
import { fanOutMatchesForRequest } from "@/src/lib/services/fanout";
import { processOutbox } from "@/src/lib/services/notifications";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesFrom = (req: NextRequest) => () =>
  Promise.resolve(
    parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }))
  );

/** GET /api/requests/[id]/matches — owner's anonymized match list. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const result = await listRequestMatches(auth, id);
  const status =
    result.ok ? 200 :
    result.code === "validation_error" ? 400 :
    result.code === "not_found" ? 404 :
    result.code === "forbidden" ? 403 : 500;
  return NextResponse.json(result, { status });
}

/**
 * POST /api/requests/[id]/matches — Phase 11E: build matches from the live
 * candidate pool and enqueue notifications for pending matches (owner/admin).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(cookiesFrom(req));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const created = await createMatchesFromCandidates(auth, id);
  const status =
    created.ok ? 200 :
    created.code === "validation_error" ? 400 :
    created.code === "not_found" ? 404 :
    created.code === "forbidden" ? 403 :
    created.code === "invalid_state" || created.code === "rate_limited" ? 409 : 500;
  if (!created.ok) return NextResponse.json(created, { status });

  // Fan out notifications to pending matches (idempotent per match+action),
  // then IMMEDIATELY sweep the outbox: there is no external scheduler, so the
  // sweep must run in-request for messages to go out without an admin cron.
  const fanned = await fanOutMatchesForRequest(auth, id);
  if (!fanned.ok) {
    return NextResponse.json(
      { ok: true, data: created.data, warning: `matches created but notification fan-out failed: ${fanned.message}` },
      { status: 200 }
    );
  }
  const sweep = await processOutbox();
  return NextResponse.json(
    {
      ok: true,
      data: {
        ...created.data,
        enqueued: fanned.data.enqueued,
        alreadyQueued: fanned.data.alreadyQueued,
        processed: sweep.ok ? sweep.data : null,
      },
    },
    { status: 200 }
  );
}
