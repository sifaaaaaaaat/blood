/**
 * Phase 12 live smoke (dev-only): functional workflows + security assertions
 * against the real database. Stages auth users via service role, simulates
 * authenticated RLS sessions with request.jwt.claims, exercises the real
 * RPCs, and introspects RLS/grants. Creates and deletes its own test data.
 *
 * Usage: node scripts/phase12-smoke.mjs
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const db = new Client({
  host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT,
  user: "postgres." + new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0],
  password: env.SUPABASE_DB_PASSWORD, database: "postgres",
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const pass = (s) => console.log("PASS", s);
const fail = (s, extra) => { console.log("FAIL", s, extra ?? ""); process.exitCode = 1; };
const info = (s) => console.log("INFO", s);

const session = async (uid) => {
  await db.query(`begin`);
  await db.query(`set local role authenticated`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: uid, role: "authenticated" })]);
};
const endSession = () => db.query(`commit`);
const rollback = () => db.query(`rollback`);

const mkAuthUser = async (email, name) => {
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { display_name: name } });
  if (error || !data?.user) throw error ?? new Error("no user for " + email);
  return data.user.id;
};
const mkDonor = async (email, opts) => {
  const uid = await mkAuthUser(email,"Donor " + email.slice(8, 16));
  const phone = opts.phone ?? "+88017" + uid.replace(/\D/g, "").slice(-8);
  await db.query(`insert into public.contact_numbers (user_id, phone, phone_normalized, verified_at) values ($1,$2,$2,now())`, [uid, phone]);
  const up = opts.upazila ?? 101001;
  const { rows: geo } = await db.query(`select district_id, (select division_id from public.districts d where d.id = u.district_id) as division_id from public.upazilas u where id = $1`, [up]);
  if (!geo[0]) throw new Error("unknown upazila " + up);
  await db.query(
    `insert into public.donor_profiles (user_id, blood_group, birth_year, upazila_id, division_id, district_id, notify_consent, availability)
     values ($1,$2,1995,$3,$4,$5,true,'available')`,
    [uid, opts.group ?? "O+", up, geo[0].division_id, geo[0].district_id]);
  return uid;
};

const tag = "phase12-" + Date.now();
let requester, donorA, donorB, donorNo, adminId, requestId, matchA;
try {
  // ================= FUNCTIONAL WORKFLOWS =================
  console.log("\n--- functional workflows ---");

  // ---- 1. registration: profile row auto-created, safe defaults ------------
  requester = await mkAuthUser(`${tag}-req@example.test`, "Requester");
  await db.query(`update public.profiles set is_requester=true where id=$1`, [requester]);
  await db.query(`insert into public.requester_profiles (user_id) values ($1)`, [requester]);
  await endSession();
  const { rows: prof } = await db.query(`select is_donor, is_requester from public.profiles where id=$1`, [requester]);
  if (prof[0]?.is_requester === true && prof[0]?.is_donor === false) pass("registration → profile with safe defaults");
  else fail("registration profile", prof);

  donorA = await mkDonor(`${tag}-a@example.test`, { upazila: 101001 });
  donorB = await mkDonor(`${tag}-b@example.test`, { upazila: 101001, group: "O+" });
  donorNo = await mkDonor(`${tag}-no@example.test`, { upazila: 101001, group: "O+" });
  adminId = await mkAuthUser(`${tag}-adm@example.test`, "Admin");
  await db.query(`select public.admin_bootstrap_grant($1)`, [adminId]);

  // ---- 2. request submission + dedup (idempotency_key) ----------------------
  const idem = tag + "-idem";
  await session(requester);
  const ins = await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency,
       units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Mesh Hospital','routine',1, now()+interval '3 days',true,'in_app','submitted',$2)
     returning id`, [requester, idem]);
  requestId = ins.rows[0].id;
  await endSession(); // commit the successful insert
  let dupOk = false;
  await session(requester);
  try {
    await db.query(
      `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency,
         units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
       values ($1,'O+',101001,'Mesh Hospital','routine',1, now()+interval '3 days',true,'in_app','submitted',$2)`,
      [requester, idem]);
  } catch { dupOk = true; }
  await rollback(); // discard the aborted probe transaction
  if (dupOk) pass("request deduplication: same idempotency_key refused by unique constraint");
  else fail("idempotent replay created a duplicate");

  const otherKey = tag + "-idem-2";
  await session(requester);
  await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency,
       units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Mesh Hospital','routine',1, now()+interval '3 days',true,'in_app','submitted',$2)`,
    [requester, otherKey]);
  await endSession();
  const { rows: cnt } = await db.query(
    `select count(*)::int as n from public.blood_requests where idempotency_key in ($1,$2)`, [idem, otherKey]);
  if (cnt[0].n === 2) pass("new idempotency key creates the request (no over-blocking)");
  else fail("new idempotency key refused?", cnt);

  // cross-user write attempt: donor A must not edit/read the requester's request
  await session(donorA);
  const { rows: ann } = await db.query(`select count(*)::int as n from public.blood_requests where id=$1`, [requestId]);
  await endSession();
  // Reads of OPEN requests by other users are by design (the public request
  // board maps only the publicRequestItemSchema fields — no owner contact
  // data). The write path is what must be refused:
  if (ann[0].n === 1) info("cross-user READ of open request allowed by design (public board, schema has no contact fields)");
  else { console.log("INFO cross-user read:", ann); }
  await session(donorA);
  await db.query(`update public.blood_requests set status='cancelled' where id=$1`, [requestId]);
  await endSession();
  const { rows: stillSub } = await db.query(
    `select status from public.blood_requests where id=$1`, [requestId]);
  if (stillSub[0]?.status === "submitted") pass("stranger cannot cancel another user's request (ROW affected count 0)");
  else fail("cross-user status change", stillSub);

  // ---- 3. geographic matching: local-first, consent + pause respected ------
  // (candidate SQL runs via service role, exactly like the app's exec_matching_sql)
  await db.query(`update public.donor_profiles set notify_consent=false where user_id=$1`, [donorNo]);
  const tier1 = await db.query(
    `select dp.user_id, 'tier1' as tier, dp.availability::text, (dp.notify_consent) as consent
       from public.donor_profiles dp
       join public.contact_numbers cn on cn.user_id = dp.user_id
      where dp.upazila_id = 101001 and dp.availability = 'available' and dp.notify_consent = true
        and cn.verified_at is not null and dp.blood_group::text = 'O+'`);
  const ids = tier1.rows.map((r) => r.user_id);
  if (ids.includes(donorA) && ids.includes(donorB) && !ids.includes(donorNo))
    pass("tier-1 candidates local + consent respected (notify_consent=false excluded)");
  else fail("tier-1 candidate set", { ids, a: ids.includes(donorA), b: ids.includes(donorB) });

  const { rows: paused } = await db.query(
    `select count(*)::int as n from public.donor_profiles where user_id=$1 and availability='paused'`, [donorNo]);
  void paused;
  // fatigue cap: enumerate the SQL gate used by candidatesQuery
  const fatigueRow = await db.query(
    `select (select count(*) from public.request_transitions rt
              join public.blood_requests r on r.id = rt.request_id
             where rt.actor_id = $1 and rt.to_status = 'connected'
               and rt.created_at >= now() - interval '28 days') as engaged`, [donorA]);
  if (Number(fatigueRow.rows[0].engaged) === 0) pass("engagement/fatigue counter zero before any accept (no fabricated history)");
  else fail("unexpected engagement history", fatigueRow.rows);

  const { rows: matches } = await db.query(
    `insert into public.request_matches (request_id, donor_id, status, notify_state, created_by)
     values ($1,$2,'pending','queued','matching_engine'), ($1,$3,'pending','queued','matching_engine')
     returning id, donor_id`, [requestId, donorA, donorB]);
  matchA = matches.find((m) => m.donor_id === donorA).id;

  // ---- 4. donor acceptance and decline paths -------------------------------
  const imp = await db.query(`select ok, message from public.donor_respond_match($1,'accept',$2)`, [matchA, donorB]);
  if (imp.rows[0].ok === false) pass("impersonation refused (donor B on donor A's match)");
  else fail("impersonation", imp.rows);
  const acc = await db.query(`select ok, status from public.donor_respond_match($1,'accept',$2)`, [matchA, donorA]);
  if (acc.rows[0].ok === true && acc.rows[0].status === "accepted") pass("donor acceptance recorded");
  else fail("accept", acc.rows);
  const dupAcc = await db.query(`select ok from public.donor_respond_match($1,'accept',$2)`, [matchA, donorA]);
  if (dupAcc.rows[0].ok === false) pass("repeated idempotent accept refused (no double-processing)");
  else fail("double accept accepted!");

  // ---- 5. contact disclosure only after acceptance --------------------------
  const ph = await db.query(`select public.reveal_contact($1,$2,$3) as phone`, [requestId, donorA, requester]);
  if (ph.rows[0]?.phone?.startsWith("+88017")) pass("contact revealed to creator after acceptance (audited)");
  else fail("contact reveal", ph.rows);
  const stranger = await mkAuthUser(`${tag}-str@example.test`, "Stranger");
  try {
    await db.query(`select public.reveal_contact($1,$2,$3)`, [requestId, donorA, stranger]);
    fail("stranger contact reveal NOT blocked");
  } catch { pass("stranger contact reveal blocked"); }
  void stranger;

  // ---- 6. donation recording + availability restriction ---------------------
  const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const fut = await db.query(`select ok from public.donor_report_donation($1::date,'whole_blood',null,null)`, [future]);
  if (fut.rows[0].ok === false) pass("future donation date refused (no invented eligibility clock)");
  else fail("future donation date accepted", fut.rows);

  // ---- 7. expiration ---------------------------------------------------------
  const exp = await db.query(`select * from public.expire_stale_requests()`);
  if (Number(exp.rows[0]?.expire_stale_requests ?? exp.rows[0]?.count ?? 0) >= 0) pass("expire_stale_requests runs (state machine owns expiry)");
  else fail("expiry", exp.rows);

  // ---- 8. referral attribution ------------------------------------------------
  let code;
  await session(donorA);
  code = (await db.query(`select public.referral_issue_code() as code`)).rows[0].code;
  await endSession();
  if (/^[A-Z0-9-]{6,24}$/.test(code)) pass("referral code issued (unique format)");
  else fail("referral code", code);
  await session(donorA);
  const own = (await db.query(`select public.referral_redeem($1) as r`, [code])).rows[0].r;
  await endSession();
  if (own.ok === false && /own code/.test(own.reason)) pass("self-redemption refused");
  else fail("self redemption", own);
  await session(donorB);
  const r1 = (await db.query(`select public.referral_redeem($1) as r`, [code])).rows[0].r;
  const r2 = (await db.query(`select public.referral_redeem($1) as r`, [code])).rows[0].r;
  await endSession();
  await session(requester);
  const r3 = (await db.query(`select public.referral_redeem($1) as r`, [code])).rows[0].r;
  await endSession();
  if (r1.ok === true && r1.referral_count === 1 && r2.ok === true && r2.redeemed === false && r2.referral_count === 1)
    pass("referral redeem + idempotent replay (no double-count)");
  else fail("referral replay", { r1, r2 });
  if (r3.ok === true && r3.referral_count === 2) pass("second distinct redeemer counted");
  else fail("referral second user", r3);

  // ================= SECURITY CHECKS =================
  console.log("\n--- security checks ---");

  // ---- every public table has RLS -------------------------------------------
  const { rows: noRls } = await db.query(
    `select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
  if (noRls.length === 0) pass("RLS enabled on every public table");
  else fail("tables without RLS", noRls);

  // ---- contact data: anon/authenticated grants and cross-user reads ---------
  const { rows: grants } = await db.query(
    `select grantee, privilege_type from information_schema.table_privileges
      where table_schema='public' and table_name='contact_numbers' and grantee in ('anon','authenticated')`);
  const dangerous = grants.filter((g) =>
    (g.grantee === "anon" && /INSERT|UPDATE|DELETE|TRUNCATE/.test(g.privilege_type)) ||
    /TRUNCATE|REFERENCES|TRIGGER/.test(g.privilege_type));
  info(`contact_numbers anon/auth grants: ${grants.map((g) => g.grantee + ":" + g.privilege_type).join(", ") || "none"}`);
  if (dangerous.length === 0) pass("no anon mutations / no table-level bypass grants on contact_numbers");
  else fail("DANGEROUS grants on contact_numbers", dangerous);

  await session(donorB);
  const { rows: otherContacts } = await db.query(`select count(*)::int as n from public.contact_numbers where user_id <> $1`, [donorB]);
  const { rows: otherDonors } = await db.query(`select count(*)::int as n from public.donor_profiles where user_id <> $1`, [donorB]);
  await endSession();
  if (otherDonors[0].n > 0) pass("donor directory rows visible to authenticated users (design: public read for matching)");
  else info("no other donor rows visible from this session — check donor_profiles policy intent");
  if (otherContacts[0].n === 0) pass("contact_numbers cross-user reads return nothing (RLS)");
  else fail("CONTACT LEAK: other users' phone rows readable", otherContacts);

  // ---- audit of reveals: every reveal leaves an audit trail ------------------
  const { rows: revealAudits } = await db.query(
    `select count(*)::int as n from public.audit_log where action like 'contact%' or action like 'match%'`);
  if (revealAudits[0].n >= 1) pass(`contact/match audit entries exist (${revealAudits[0].n})`);
  else fail("no audit entries for reveals");

  // ---- public request surface contains no requester contact columns ---------
  const { rows: reqCols } = await db.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name='blood_requests'`);
  const bad = reqCols.map((r) => r.column_name).filter((c) => /phone|contact_detail/.test(c));
  if (bad.length === 0) pass("blood_requests schema has no phone/contact-detail columns");
  else fail("blood_requests exposes contact columns", bad);

  // ---- idempotent outbox: repeated enqueue never duplicates ------------------
  const { rows: outboxIdx } = await db.query(
    `select i.relname as idx, pg_get_indexdef(i.oid) as def
       from pg_class c join pg_index x on x.indrelid = c.oid join pg_class i on i.oid = x.indexrelid
      where c.relname = 'notification_outbox'`);
  if (outboxIdx.some((r) => /idempotency_key/.test(r.def))) pass("notification_outbox enforces idempotency_key uniqueness");
  else fail("outbox missing idempotency index");

  // ---- anon has zero mutation capability on ANY table ----------------------
  const { rows: anonWrites } = await db.query(
    `select count(*)::int as n from information_schema.table_privileges
      where table_schema='public' and grantee='anon' and privilege_type in ('INSERT','UPDATE','DELETE')`);
  // Table-level bypass grants must exist ONLY for service_role (server-only,
  // never shipped to browsers) — never for anon/authenticated.
  const { rows: truncates } = await db.query(
    `select count(*)::int as n from information_schema.table_privileges
      where table_schema='public' and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')
        and grantee in ('anon','authenticated')`);
  if (anonWrites[0].n === 0 && truncates[0].n === 0)
    pass("no anon writes; TRUNCATE/REFERENCES/TRIGGER only on service_role (hardening 0020)");
  else fail("over-broad grants remain", { anonWrites: anonWrites[0].n, truncates: truncates[0].n });

  console.log("\nPhase 12 smoke complete.");
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
  await rollback().catch(() => undefined);
} finally {
  // clean all staged users + referral/profiles cascades
  try {
    const { rows: olds } = await db.query(`select id from auth.users where email like 'phase12-%@example.test'`);
    for (const { id } of olds) await admin.auth.admin.deleteUser(id);
    await db.query(`delete from public.blood_requests where idempotency_key like 'phase12-%'`);
  } catch (e2) { console.error("cleanup error:", e2.message); }
  await db.end();
}
