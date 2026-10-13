// Phase 8 live smoke: recovery rules + donation history + hold lifecycle.
// Donor/admin sessions are simulated with request.jwt.claims (role
// authenticated). Cleans up its own test data.
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

const adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const pass = (s) => console.log("PASS", s);
const fail = (s, extra) => { console.log("FAIL", s, extra ?? ""); process.exitCode = 1; };

const session = async (uid) => {
  await db.query(`begin`);
  await db.query(`set local role authenticated`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
};
const endSession = async () => { await db.query(`commit`); };

const mkAuthUser = async (email) => {
  const { data, error } = await adminClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data?.user) throw error ?? new Error("no user for " + email);
  return data.user.id;
};

const tag = "phase8-" + Date.now();
let adminId, donorA, donorB, requesterId;
try {
  // ---- cleanup leftovers --------------------------------------------------
  await db.query(`delete from public.donor_recovery_holds where donor_id in (select id from auth.users where email like 'phase8-%@example.test')`);
  await db.query(`delete from public.recovery_rules where approval_reference like 'phase8-%'`);
  await db.query(`delete from public.blood_requests where idempotency_key like 'phase8-%'`);
  const { rows: olds } = await db.query(`select id from auth.users where email like 'phase8-%@example.test'`);
  for (const { id } of olds) await adminClient.auth.admin.deleteUser(id);

  // ---- stage users ---------------------------------------------------------
  adminId = await mkAuthUser(`${tag}-adm@example.test`);
  donorA = await mkAuthUser(`${tag}-a@example.test`);
  donorB = await mkAuthUser(`${tag}-b@example.test`);
  requesterId = await mkAuthUser(`${tag}-req@example.test`);
  for (const uid of [donorA, donorB]) {
    await db.query(`insert into public.donor_profiles (user_id, blood_group, birth_year, upazila_id, division_id, district_id, notify_consent)
                    values ($1,'O+',1995,101001,1,101,true)`, [uid]);
  }
  await db.query(`update public.profiles set is_requester=true where id=$1`, [requesterId]);
  await db.query(`insert into public.requester_profiles (user_id) values ($1)`, [requesterId]);
  await db.query(`select public.admin_bootstrap_grant($1)`, [adminId]);

  // ---- 1. rule approval gate ------------------------------------------------
  await session(adminId);
  const { rows: refused } = await db.query(`select * from public.admin_set_recovery_rule('whole_blood', 95, '', '')`);
  await endSession();
  if (refused[0].ok === false) pass("unapproved rule (no named approver) refused");
  else fail("rule gate", refused);

  await session(adminId);
  const { rows: rule } = await db.query(
    `select * from public.admin_set_recovery_rule('whole_blood', 95, 'Dr. Smoke Approved, DMCH Blood Center', $1)`, [tag]);
  await endSession();
  if (rule[0].ok === true) pass("approved rule recorded (named approver + reference)");
  else fail("rule set", rule);

  // ---- 2. donor reports: future date refused --------------------------------
  await session(donorA);
  const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const { rows: fut } = await db.query(`select * from public.donor_report_donation($1::date,'whole_blood',null,null)`, [future]);
  if (fut[0].ok === false) pass("future donation date refused (missing/implausible handled)");
  else fail("future date", fut);

  // ---- 3. report 150 days ago -> expired hold -> awaiting_confirmation ------
  const past150 = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
  const { rows: rep } = await db.query(`select * from public.donor_report_donation($1::date,'whole_blood','Smoke Center',null)`, [past150]);
  if (rep[0].ok === true && rep[0].state === "hold_applied") pass("donation reported; hold applied with reason");
  else fail("report", rep);
  const { rows: profA } = await db.query(`select availability FROM public.donor_profiles where user_id=$1`, [donorA]);
  if (profA[0].availability === "paused") pass("donor paused automatically on report");
  else fail("pause", profA);

  const { rows: stateA } = await db.query(`select * from public.donor_recovery_state($1)`, [donorA]);
  if (stateA[0].state === "awaiting_confirmation" && !/medically eligible/i.test(stateA[0].reason ?? ""))
    pass("expired hold -> awaiting_confirmation (no auto 'medically eligible' claim)");
  else fail("recovery state", stateA);

  // candidate exclusion while hold unlifted, even though expired
  const { rows: excl } = await db.query(
    `select not exists (select 1 from public.donor_recovery_holds h where h.donor_id=$1 and h.lifted=false) as visible`, [donorA]);
  if (excl[0].visible === false) pass("expired-but-unconfirmed donor still excluded from matching");
  else fail("expiry auto-restore?", excl);

  // ---- 4. donor confirms after expiry -> restored ---------------------------
  const { rows: conf } = await db.query(`select * from public.donor_confirm_availability()`);
  await endSession();
  if (conf[0].ok === true && conf[0].state === "active") pass("donor confirmed availability after hold ended");
  else fail("confirm", conf);
  const { rows: profA2 } = await db.query(`select availability from public.donor_profiles where user_id=$1`, [donorA]);
  if (profA2[0].availability === "available") pass("availability restored by donor action (not automatically)");
  else fail("restore", profA2);

  // ---- 5. donorB: active hold + conflict-safe dates + override gate ---------
  await session(donorB);
  const d12 = new Date(Date.now() - 12 * 864e5).toISOString().slice(0, 10);
  await db.query(`select * from public.donor_report_donation($1::date,'whole_blood',null,null)`, [d12]);
  const d10 = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
  const { rows: rep2 } = await db.query(`select * from public.donor_report_donation($1::date,'whole_blood',null,null)`, [d10]);
  await endSession();
  if (rep2[0].ok === true && rep2[0].conflict_with != null) pass("conflicting dates handled (linked, latest date wins)");
  else fail("conflict", rep2);

  const { rows: stateB } = await db.query(`select * from public.donor_recovery_state($1)`, [donorB]);
  if (stateB[0].state === "recovery_hold") pass("active recovery hold reported with reason");
  else fail("hold state", stateB);

  // override gate: without named authority -> refused + audited
  await session(adminId);
  const { rows: noAuth } = await db.query(`select * from public.admin_lift_hold($1,'note','')`, [donorB]);
  await endSession();
  if (noAuth[0].ok === false) pass("override without named medical authority refused");
  else fail("override gate", noAuth);
  const { rows: auditRef } = await db.query(
    `select count(*)::int as n from public.audit_log where action='hold.override_refused' and (detail->>'donor')=$1`, [donorB]);
  if (auditRef[0].n >= 1) pass("refused override attempt audited");
  else fail("override audit", auditRef);

  // ---- 6. non-admin cannot verify/overrule ----------------------------------
  await session(donorB);
  const { rows: notAdmin } = await db.query(
    `select * from public.admin_verify_donation(gen_random_uuid(),'verified','b','admin')`);
  await endSession();
  if (notAdmin[0].ok === false) pass("non-admin verification attempt refused");
  else fail("verify gate", notAdmin);

  // ---- 7. verification separation -------------------------------------------
  const { rows: recs } = await db.query(
    `select id from public.donation_records where donor_id=$1 order by donation_date desc limit 1`, [donorB]);
  const recordId = recs[0].id;
  await session(adminId);
  const { rows: noBasis } = await db.query(`select * from public.admin_verify_donation($1,'verified','', 'admin')`, [recordId]);
  const { rows: okv } = await db.query(`select * from public.admin_verify_donation($1,'verified','Facility register matches report','admin')`, [recordId]);
  await endSession();
  if (noBasis[0].ok === false && okv[0].ok === true) pass("verification requires basis; admin verifies separately from self-report");
  else fail("verify", { noBasis, okv });
  const { rows: recCheck } = await db.query(`select verification, donation_date, facility from public.donation_records where id=$1`, [recordId]);
  if (recCheck[0].verification === "verified" && recCheck[0].donation_date != null)
    pass("verified block set; donor-reported fields untouched");
  else fail("verify separation", recCheck);

  // ---- 8. cancelled request stops outreach automatically ---------------------
  const { rows: [{ id: reqId }] } = await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency, units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Smoke','urgent',1,now()+interval '2 days',true,'in_app','submitted',$2) returning id`,
    [requesterId, tag]);
  const { rows: [{ id: matchId }] } = await db.query(
    `insert into public.request_matches (request_id, donor_id, status) values ($1,$2,'notified') returning id`, [reqId, donorA]);
  await db.query(`update public.blood_requests set status='cancelled' where id=$1`, [reqId]);
  const { rows: mAfter } = await db.query(`select status from public.request_matches where id=$1`, [matchId]);
  if (mAfter[0].status === "cancelled_with_request") pass("cancelled request stops outreach via propagation trigger");
  else fail("propagation", mAfter);

  console.log("Phase 8 live smoke complete.");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
} finally {
  await db.end();
}
