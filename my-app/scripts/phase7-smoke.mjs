// Phase 7 live smoke: outbox claim gates + simulated completion + guards.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const db = new Client({
  host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT,
  user: "postgres." + new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0],
  password: env.SUPABASE_DB_PASSWORD, database: "postgres",
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const pass = (s) => console.log("PASS", s);
const fail = (s, extra) => { console.log("FAIL", s, extra ?? ""); process.exitCode = 1; };

const mkAuthUser = async (email) => {
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data?.user) throw error ?? new Error("no user for " + email);
  return data.user.id;
};
const tag = "phase7-" + Date.now();
try {
  // ---- cleanup leftovers from previous smoke runs (self-isolating) ------------
  await db.query(`delete from public.notification_attempts a using public.notification_outbox o where a.outbox_id=o.id and o.idempotency_key like 'phase7-%'`);
  await db.query(`delete from public.notification_outbox where idempotency_key like 'phase7-%'`);
  await db.query(`delete from public.blood_requests where idempotency_key like 'phase7-%'`);
  const { rows: oldIds } = await db.query(
    `select id from auth.users where email like 'phase7-%@example.test'`);
  for (const { id } of oldIds) await admin.auth.admin.deleteUser(id);

  // ---- stage: donor (consent ON), donor without consent, requester -----------------
  const donorId = await mkAuthUser(`${tag}-donor@example.test`);
  const noConsentId = await mkAuthUser(`${tag}-noconsent@example.test`);
  const requesterId = await mkAuthUser(`${tag}-req@example.test`);
  for (const [uid, consent] of [[donorId, true], [noConsentId, false]]) {
    await db.query(`insert into public.donor_profiles (user_id, blood_group, birth_year, upazila_id, division_id, district_id, notify_consent) values ($1,'O+',1995,101001,1,101,$2)`, [uid, consent]);
  }
  await db.query(`update public.profiles set is_requester=true where id=$1`, [requesterId]);
  await db.query(`insert into public.requester_profiles (user_id) values ($1)`, [requesterId]);

  const { rows: [{ id: reqId }] } = await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency, units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Smoke Hospital','urgent',2,now()+interval '2 days',true,'in_app','submitted',$2) returning id`,
    [requesterId, tag]);
  const { rows: [{ id: cancelledReqId }] } = await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency, units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Cancelled Hospital','urgent',2,now()+interval '2 days',true,'in_app','cancelled',$2) returning id`,
    [requesterId, tag + "-c"]);

  // three outbox rows: consented, consent-off, cancelled-request
  const { rows: obRows } = await db.query(
    `insert into public.notification_outbox
       (idempotency_key, request_id, recipient_id, provider, message_type)
     values
       ($1, $4, $5, 'mock', 'match_action'),
       ($2, $4, $6, 'mock', 'match_action'),
       ($3, $7, $5, 'mock', 'match_action')
     returning id, idempotency_key`,
    [tag + "-ok", tag + "-noconsent", tag + "-cancelled", reqId, donorId, noConsentId, cancelledReqId]);
  const okId = obRows.find((r) => r.idempotency_key === tag + "-ok").id;

  // ---- 1. claim: consent + request-state gates --------------------------------
  const claim = await db.query(`select id from public.claim_outbox_batch(10, 5)`);
  if (claim.rows.length === 1 && claim.rows[0].id === okId) pass("claim gate: only consented + live-request row claimed");
  else fail("claim gates", claim.rows);
  const { rows: st } = await db.query(`select id, status from public.notification_outbox where request_id=$1`, [cancelledReqId]);
  if (st[0]?.status === "skipped_cancelled") pass("cancelled request skipped at claim");
  else fail("cancelled skip", st);
  const { rows: nc } = await db.query(
    `select status from public.notification_outbox where recipient_id=$1`, [noConsentId]);
  if (nc[0]?.status === "skipped_consent") pass("consent revoked → skipped_consent at send time");
  else fail("consent skip", nc);

  // ---- 2. simulated completion + idempotent replay ----------------------------
  const done = await db.query(`select public.complete_outbox_item($1,'accepted',true,'mock-smoke-1',null,2,5) as r`, [okId]);
  if (done.rows[0].r === "simulated_sent") pass("mock send recorded as simulated_sent");
  else fail("simulated completion", done.rows);
  const replay = await db.query(`select public.complete_outbox_item($1,'accepted',true,'mock-smoke-1',null,2,5) as r`, [okId]);
  if (replay.rows[0].r === "already_simulated_sent") pass("terminal replay is an idempotent no-op");
  else fail("replay", replay.rows);
  const { rows: attempts } = await db.query(
    `select count(*)::int as n from public.notification_attempts where outbox_id=$1`, [okId]);
  if (attempts[0].n === 1) pass("exactly one attempt record for one send");
  else fail("attempt records", attempts);
  const { rows: content } = await db.query(
    `select count(*)::int as n from public.notification_attempts a join public.notification_outbox o on o.id=a.outbox_id
     where a.simulated=true and a.outcome='accepted' and a.outbox_id=$1`, [okId]);
  if (content[0].n === 1) pass("simulated attempt recorded as simulated (never as real delivery)");
  else fail("simulated-vs-real boundary", content);

  // ---- 3. real-send guard: 'delivered' requires a real reference ----------------
  const { rows: [{ id: ok2Id }] } = await db.query(
    `insert into public.notification_outbox (idempotency_key, request_id, recipient_id, provider, message_type)
     values ($1,$2,$3,'real','match_action') returning id`, [tag + "-real", reqId, donorId]);
  await db.query(`update public.notification_outbox set status='sending' where id=$1`, [ok2Id]);
  const guard = await db.query(`select public.complete_outbox_item($1,'accepted',false,null,null,2,5) as r`, [ok2Id]);
  if (guard.rows[0].r === "failed") pass("real send without provider reference cannot be marked delivered");
  else fail("real-send guard", guard.rows);

  // ---- 4. staleness recovery --------------------------------------------------
  const { rows: [{ n: recovered }] } = await db.query(
    `select public.recover_stale_sending(10) as n`);
  pass(`stale recovery executed (recovered=${recovered})`);

  // expose tokens pointing at nothing: notification row must never contain content
  const { rows: nonEmpty } = await db.query(
    `select count(*)::int as n from public.notification_attempts where failure_reason like '%phone%' or failure_reason like '%token%'`);
  if (nonEmpty[0].n === 0) pass("no sensitive content in sanitized failure reasons");
  else fail("sanitization", nonEmpty);

  console.log("Phase 7 live smoke complete.");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await db.end();
}
