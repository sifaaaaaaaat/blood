import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { handleDonorWhatsAppReply } from "@/src/lib/services/whatsapp-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inbound WhatsApp webhook — called ONLY by the local whatsapp-web.js bridge
 * (see /whatsapp-bot/bot.js), authenticated with the shared bridge token in
 * the `x-bot-token` header.
 *
 * The sender's number is the donor's identity here: the service resolves it to
 * a profile and may only touch that donor's own match. Replies are returned to
 * the bridge, which sends them back into the same chat.
 */
const MAX_TEXT = 500;

function tokenMatches(provided: string | null): boolean {
  const expected = process.env.WHATSAPP_BOT_TOKEN ?? "";
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!tokenMatches(req.headers.get("x-bot-token"))) {
    return NextResponse.json({ ok: false, code: "unauthorized", message: "invalid bridge token" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { phone?: unknown; text?: unknown } | null;
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!phone || phone.length > 20 || text.length > MAX_TEXT) {
    return NextResponse.json({ ok: false, code: "validation_error", message: "phone and text required" }, { status: 400 });
  }

  const result = await handleDonorWhatsAppReply(phone, text);
  if (!result.ok) {
    const status = result.code === "validation_error" ? 400 : 500;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(
    { ok: true, data: result.data },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
