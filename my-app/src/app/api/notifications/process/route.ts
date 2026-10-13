import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { processOutbox, notificationHealth } from "@/src/lib/services/notifications";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Outbox sweeper. Intended for a trusted cron/worker; requires an
 * authenticated admin session (the mock phase). In production this would be
 * called by a scheduler holding a server-only key.
 */
export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  if (!auth.isAdmin) {
    return NextResponse.json({ ok: false, code: "forbidden", message: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const limitRaw = (body as { limit?: unknown })?.limit;
  const limit = typeof limitRaw === "number" && limitRaw > 0 && limitRaw <= 100 ? Math.floor(limitRaw) : undefined;

  const result = await processOutbox(limit);
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  const health = await notificationHealth();
  return NextResponse.json(
    { ok: true, data: { ...result.data, health: health.ok ? health.data : null } },
    { status: 200 }
  );
}
