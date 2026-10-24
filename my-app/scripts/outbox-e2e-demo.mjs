/**
 * dev-only end-to-end DEMO: full claim → phone-resolution → bridge send →
 * complete cycle against the real request/match/donor, using the paired bot
 * number as the recipient. The donor's contact number is temporarily swapped
 * in-memory and restored afterwards; phone values are never printed.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const readEnv = (p) =>
  Object.fromEntries(
    fs.readFileSync(path.resolve(p), "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
  );

const env = readEnv(".env.local");
const botEnv = readEnv("../whatsapp-bot/.env");
const PAIRED = "8801834855190"; // the number that owns the WhatsApp session

const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const REQUEST_ID = "20cace2e-c607-4d11-bf94-ce55f8c4930b";
const DONOR_ID = "347c0366-eb43-4209-8452-8b18d5346884";

// 1) swap phone in-memory
const { data: origRow } = await svc.from("contact_numbers").select("phone, phone_normalized").eq("user_id", DONOR_ID).single();
const orig = { phone: origRow.phone, phone_normalized: origRow.phone_normalized };
const swapped = `+${PAIRED}`;
const { error: swapErr } = await svc.from("contact_numbers").update({ phone: swapped, phone_normalized: swapped }).eq("user_id", DONOR_ID);
if (swapErr) { console.error("swap failed:", swapErr.message); process.exit(1); }

try {
  // 2) synthetic outbox row
  const key = `demo-e2e-${Date.now()}`;
  const { data: row, error } = await svc.from("notification_outbox").insert({
    idempotency_key: key,
    request_id: REQUEST_ID,
    recipient_id: DONOR_ID,
    provider: "whatsappWeb",
    message_type: "match_action",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }).select("id").single();
  if (error) throw new Error("insert: " + error.message);

  // 3) claim (fixed RPC resolves the phone)
  const { data: claimed, error: claimErr } = await svc.rpc("claim_outbox_batch", { p_limit: 20, p_per_recipient_limit: 5 });
  if (claimErr) throw new Error("claim: " + claimErr.message);
  const mine = (claimed ?? []).find((r) => r.id === row.id);
  if (!mine) throw new Error("row was not claimed");
  const phoneResolved = typeof mine.recipient_phone === "string" && mine.recipient_phone.replace(/^\+/, "") === PAIRED;
  console.log("phone resolution:", phoneResolved ? "OK" : "MISMATCH (never printed)");

  // 4) send through the bridge (same call the whatsappWeb provider makes)
  const res = await fetch(`${env.WHATSAPP_BOT_URL}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bot-token": botEnv.WHATSAPP_BOT_TOKEN },
    body: JSON.stringify({
      phone: mine.recipient_phone.replace(/^\+/, ""),
      text: "🩸 Blood is urgently needed near you. Please open the RoktoSathi app to view and respond.",
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log("bridge send →", res.status, body.ok ? "OK (check 'Message yourself' chat)" : body.error);

  // 5) complete + verify terminal state
  const { data: result } = await svc.rpc("complete_outbox_item", {
    p_outbox_id: row.id,
    p_outcome: res.ok ? "accepted" : "failed",
    p_simulated: false,
    p_provider_ref: res.ok ? `ww-demo-${body.id ?? Date.now()}` : null,
    p_failure_reason: res.ok ? null : String(body.error ?? "bridge error"),
    p_backoff_minutes: 2,
    p_max_attempts: 5,
  });
  const { data: final } = await svc.from("notification_outbox").select("status").eq("id", row.id).single();
  console.log("complete →", result, "| row status:", final?.status);
  await svc.from("notification_outbox").delete().eq("id", row.id);
  console.log("synthetic row cleaned up");
} finally {
  // 6) always restore the original phone
  const { error: restoreErr } = await svc.from("contact_numbers").update(orig).eq("user_id", DONOR_ID);
  console.log(restoreErr ? "phone restore FAILED: " + restoreErr.message : "original phone restored");
}
