import { NextRequest, NextResponse } from "next/server";
import {
  contactMessageSchema,
  checkContactRate,
  storeContactMessage,
} from "@/src/lib/services/content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/contact — public contact intake. Rate-capped per IP (rolling
 * window), validated, then stored for the admin inbox. The table has no
 * public SELECT policy; nothing is displayed publicly.
 */
export async function POST(req: NextRequest) {
  let key = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  key = key.split(",")[0]?.trim() || "unknown";
  if (!checkContactRate(key)) {
    return NextResponse.json({ ok: false, code: "rate_limited", message: "too many messages; try again later" }, { status: 429 });
  }
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ ok: false, code: "invalid_json", message: "JSON body required" }, { status: 400 });
  }
  const parsed = contactMessageSchema.safeParse(body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json({ ok: false, code: "validation_error", message: i.message }, { status: 400 });
  }
  const result = await storeContactMessage(parsed.data);
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result, { status: 201 });
}
