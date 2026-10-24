/**
 * dev-only diagnostic: inspect the notification outbox through the service role.
 * Prints status counts and the 10 most recent rows (no phone content printed).
 */
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);

const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const statuses = ["queued", "sending", "simulated_sent", "delivered", "failed", "expired", "skipped_consent", "skipped_cancelled"];
for (const s of statuses) {
  const { count } = await svc.from("notification_outbox").select("id", { count: "exact", head: true }).eq("status", s);
  if (count) console.log(`${s}: ${count}`);
}

const { data: recent } = await svc
  .from("notification_outbox")
  .select("id, status, provider, message_type, attempts, failure_reason, simulated, created_at, available_after, expires_at")
  .order("created_at", { ascending: false })
  .limit(10);
console.log("--- recent rows ---");
for (const r of recent ?? []) console.log(JSON.stringify(r));
