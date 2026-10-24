/**
 * dev-only diagnostic: recent request/match/donor state (no phone content).
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

const { data: reqs } = await svc
  .from("blood_requests")
  .select("id, status, blood_group, created_at")
  .order("created_at", { ascending: false })
  .limit(5);
console.log("--- blood_requests (recent) ---");
for (const r of reqs ?? []) console.log(JSON.stringify(r));

const { data: matches } = await svc
  .from("request_matches")
  .select("id, request_id, donor_id, status, created_at")
  .order("created_at", { ascending: false })
  .limit(10);
console.log("--- request_matches (recent) ---");
for (const m of matches ?? []) console.log(JSON.stringify(m));

const { data: donors } = await svc
  .from("donor_profiles")
  .select("user_id, blood_group, notify_consent, notify_channel, availability")
  .limit(10);
console.log("--- donor_profiles ---");
for (const d of donors ?? []) console.log(JSON.stringify(d));

const { data: contacts } = await svc
  .from("contact_numbers")
  .select("user_id, has_phone, verified_at")
  .limit(10)
  .maybeSingle();
// contact_numbers has no has_phone column; select properly:
const { data: cn } = await svc
  .from("contact_numbers")
  .select("user_id, verified_at, created_at")
  .order("created_at", { ascending: false })
  .limit(10);
console.log("--- contact_numbers (presence only) ---");
for (const c of cn ?? []) console.log(c.user_id, "verified:", !!c.verified_at);
