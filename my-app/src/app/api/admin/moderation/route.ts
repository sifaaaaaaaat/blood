import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import {
  listAbuseReports, listDisabledAccounts, listDeliveryFailures,
  readSettings, abuseMetrics, inspectProfile,
  reviewAbuseReport, reviewRequest, disableAccount, reviewDisabledAccount,
  grantModerator, revokeModerator, setSetting,
} from "@/src/lib/services/moderation";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookiesOf = (req: NextRequest) => async () =>
  parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));

/**
 * Phase 10 staff console (backend-only). Route-level session checks are
 * convenience gates: every mutation re-verifies roles inside its Postgres
 * function, and every read touches server-only tables (no RLS policy reads
 * exist for any authenticated role).
 */
export async function GET(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  if (!auth.isAdmin && !auth.isModerator) {
    return NextResponse.json({ ok: false, code: "forbidden", message: "staff only" }, { status: 403 });
  }
  const url = new URL(req.url);
  const resource = url.searchParams.get("resource") ?? "";
  const id = url.searchParams.get("id") ?? "";

  switch (resource) {
    case "abuse_reports":
      return NextResponse.json(await listAbuseReports(url.searchParams.get("status") ?? undefined),
        { status: 200 });
    case "disabled_accounts":
      return NextResponse.json(await listDisabledAccounts(), { status: 200 });
    case "delivery_failures":
      return NextResponse.json(await listDeliveryFailures(), { status: 200 });
    case "settings":
      if (!auth.isAdmin) {
        return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
      }
      return NextResponse.json(await readSettings(), { status: 200 });
    case "metrics":
      return NextResponse.json(await abuseMetrics(), { status: 200 });
    case "profile":
      if (!id) {
        return NextResponse.json({ ok: false, code: "validation_error", message: "id required" }, { status: 400 });
      }
      {
        const r = await inspectProfile(c, auth, id);
        return NextResponse.json(r, { status: r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "not_found" ? 404 : 500 });
      }
    default:
      return NextResponse.json({ ok: false, code: "validation_error", message: "unknown resource" }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  const c = cookiesOf(req);
  const auth = await getAuthUser(c);
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  if (!auth.isAdmin && !auth.isModerator) {
    return NextResponse.json({ ok: false, code: "forbidden", message: "staff only" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body?.action || typeof body.action !== "string") {
    return NextResponse.json({ ok: false, code: "validation_error", message: "action required" }, { status: 400 });
  }

  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const fail = (message: string) =>
    NextResponse.json({ ok: false, code: "validation_error", message }, { status: 400 });
  const finish = (r: { ok: boolean; code?: string }) =>
    NextResponse.json(r, { status: r.ok ? 200 : r.code === "forbidden" ? 403 : r.code === "rejected" ? 400 : 500 });

  switch (body.action) {
    case "review_report": {
      const decision = str("decision");
      if (!str("id") || !decision || !["reviewing", "actioned", "dismissed"].includes(decision)) {
        return fail("id and decision (reviewing|actioned|dismissed) required");
      }
      return finish(await reviewAbuseReport(c, auth, str("id")!, decision as "reviewing", str("note") ?? ""));
    }
    case "review_request": {
      const action = str("sub_action");
      if (!str("id") || !action || !["flag", "clear", "cancel"].includes(action)) {
        return fail("id and sub_action (flag|clear|cancel) required");
      }
      return finish(await reviewRequest(c, auth, str("id")!, action as "flag", str("note") ?? ""));
    }
    case "disable_account": {
      if (!str("id") || !str("reason")) return fail("id and reason required");
      return finish(await disableAccount(c, auth, str("id")!, str("reason")!));
    }
    case "reinstate_account":
    case "confirm_disable": {
      // Admin only — the service refuses moderators before any DB call.
      if (!auth.isAdmin) {
        return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
      }
      if (!str("id") || !str("note")) return fail("id and note required");
      const decision = body.action === "reinstate_account" ? "reinstate" : "confirm";
      return finish(await reviewDisabledAccount(c, auth, str("id")!, decision, str("note")!));
    }
    case "grant_moderator": {
      if (!auth.isAdmin) {
        return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
      }
      if (!str("id")) return fail("id required");
      return finish(await grantModerator(c, auth, str("id")!, str("note")));
    }
    case "revoke_moderator": {
      if (!auth.isAdmin) {
        return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
      }
      if (!str("id")) return fail("id required");
      return finish(await revokeModerator(c, auth, str("id")!));
    }
    case "set_setting": {
      if (!auth.isAdmin) {
        return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
      }
      const key = str("key");
      const category = str("category");
      const value = body.value as unknown;
      if (!key || !category || !["rate_limits", "moderation", "operational"].includes(category)) {
        return fail("key and category (rate_limits|moderation|operational) required");
      }
      if (!["number", "string", "boolean"].includes(typeof value)) {
        return fail("value must be a scalar");
      }
      return finish(await setSetting(c, auth, key, value as number, category as "rate_limits", str("note")));
    }
    default:
      return fail("unknown action");
  }
}
