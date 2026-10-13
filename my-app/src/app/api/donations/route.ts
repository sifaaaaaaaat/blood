import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/src/lib/auth";
import { reportDonation, listMyDonations } from "@/src/lib/services/donations";
import { parseCookieHeader } from "@supabase/ssr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as
    | { donationDate?: string; donationType?: string; facility?: string; note?: string }
    | null;
  if (!body?.donationDate || !body?.donationType) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "donationDate and donationType are required" }, { status: 400 });
  }
  const result = await reportDonation(auth, {
    donationDate: String(body.donationDate),
    donationType: String(body.donationType),
    facility: body.facility ? String(body.facility) : undefined,
    note: body.note ? String(body.note) : undefined,
  });
  const status =
    result.ok ? 201 :
    result.code === "validation_error" ? 400 :
    result.code === "unauthorized" ? 401 : 500;
  return NextResponse.json(result, { status });
}

export async function GET(req: NextRequest) {
  const cookies = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value }));
  const auth = await getAuthUser(() => Promise.resolve(cookies));
  if (!auth) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "sign-in required" }, { status: 401 });
  }
  const result = await listMyDonations(auth);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
