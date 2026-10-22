import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { adminVerifyDonation } from "@/src/lib/services/donations";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { status?: string; basis?: string; actorRole?: string } | null;
  if (!body?.status || !["verified", "rejected", "unverified"].includes(body.status)) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "status must be verified|rejected|unverified" }, { status: 400 });
  }
  if (body.status === "verified" && !body.basis) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "basis required to verify" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await adminVerifyDonation(
    auth, id,
    body.status as "verified" | "rejected" | "unverified",
    String(body.basis ?? ""),
    body.actorRole === "partner" ? "partner" : "admin"
  );
  const status =
    result.ok ? 200 :
    result.code === "forbidden" ? 403 :
    result.code === "rejected" || result.code === "validation_error" ? 400 : 500;
  return NextResponse.json(result, { status });
}
