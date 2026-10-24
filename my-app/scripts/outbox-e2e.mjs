/**
 * dev-only end-to-end probe of the FIXED notification pipeline:
 *   claim_outbox_batch (with the new phone resolution) → bridge /send →
 *   complete_outbox_item → verify 'delivered', then remove the synthetic row.
 * Uses a synthetic outbox row tagged test-e2e-<ts>; real request/match/donor.
 * Never prints phone content.
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

const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const REQUEST_ID = "20cace2e-c607-4d11-bf94-ce55f8c4930b"; // submitted, has pending match to a consented verified donor
const DONOR_ID = "347c0366-eb43-4209-8452-8b18d5346884";
const key = `test-e2e-${Date.now()}`;

const { data: ins, error: insErr } = await svc.from("notification_outbox").insert({
  idempotency_key: key,
  request_id: REQUEST_ID,
  recipient_id: DONOR_ID,
  provider: "whatsappWeb",
  message_type: "match_action",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
}).select("id").single();
if (insErr) { console.error("insert failed:", insErr.message); process.exit(1); }
console.log("synthetic row:", ins.id);

const { data: claimed, error: claimErr } = await svc.rpc("claim_outbox_batch", { p_limit: 20, p_per_recipient_limit: 5 });
if (claimErr) { console.error("claim failed:", claimErr.message); process.exit(1); }

for (const r of claimed ?? []) {
  const phoneResolved = typeof r.recipient_phone === "string" && r.recipient_phone.startsWith("+8801");
  console.log(`claimed ${r.id.slice(0, 8)} provider=${r.provider} phoneResolved=${phoneResolved ? "yes" : "no"}`);

  if (r.id !== ins.id) continue; // only send for our synthetic row

  if (!phoneResolved) { console.error("PHONE NOT RESOLVED — migration fix failed"); process.exit(1); }

  const res = await fetch(`${env.WHATSAPP_BOT_URL}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bot-token": botEnv.WHATSAPP_BOT_TOKEN },
    body: JSON.stringify({ phone: r.recipient_phone.replace(/^\+/, ""), text: "🩸 Blood is urgently needed near you. Please open the RoktoSathi app to view and respond." }),
  });
  const body = await res.json().catch(() => ({}));
  console.log("bridge send →", res.status, body.ok ? "ok" : body.error);

  const ref = `ww-e2e-${body.id || crypto.randomUUID}`;
  const { data: result } = await svc.rpc("complete_outbox_item", {
    p_outbox_id: ins.id,
    p_outcome: res.ok ? "accepted" : "failed",
    p_simulated: false,
    p_provider_ref: res.ok ? ref : null,
    p_failure_reason: res.ok ? null : String(body.error ?? "bridge error"),
    p_backoff_minutes: 2,
    p_max_attempts: 5,
  });
  console.log("complete →", result);

  const { data: row } = await svc.from("notification_outbox").select("status, provider_ref").eq("id", ins.id).single();
  console.log("final row status:", row?.status);

  await svc.from("notification_outbox").delete().eq("id", ins.id);
  console.log("synthetic row cleaned up");
}
