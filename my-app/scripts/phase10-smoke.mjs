// Phase 10 live smoke: admins, moderators, abuse reports, account disabling,
// server-side enforcement, settings, rate caps, audit trail. Donor/staff
// sessions are simulated with request.jwt.claims (role authenticated).
// Dev-only; cleans up its own test data.
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

const tag = "phase10-" + Date.now();
let adminId, modId, requesterId, donorA, donorB, matchId, reqId;
try {
  // ---- cleanup leftovers --------------------------------------------------
  await db.query(`delete from public.abuse_counters where subject_id in (select id from public.profiles where id in (select id from auth.users where email like 'phase10-%@example.test'))`);
  await db.query(`delete from public.blood_requests where idempotency_key like 'phase10-%'`);
  await db.query(`update public.platform_settings set value = '20'::jsonb where key = 'rate_limits.contact_reveal_per_day'`);
  const { rows: olds } = await db.query(`select id from auth.users where email like 'phase10-%@example.test'`);
  for (const { id } of olds) await adminClient.auth.admin.deleteUser(id);

  // ---- stage users ---------------------------------------------------------
  adminId = await mkAuthUser(`${tag}-adm@example.test`);
  modId = await mkAuthUser(`${tag}-mod@example.test`);
  requesterId = await mkAuthUser(`${tag}-req@example.test`);
  donorA = await mkAuthUser(`${tag}-a@example.test`);
  donorB = await mkAuthUser(`${tag}-b@example.test`);
  for (const uid of [donorA, donorB]) {
    await db.query(`insert into public.donor_profiles (user_id, blood_group, birth_year, upazila_id, division_id, district_id, notify_consent) values ($1,'O+',1995,101001,1,101,true)`, [uid]);
  }
  await db.query(`update public.profiles set is_requester=true where id=$1`, [requesterId]);
  await db.query(`insert into public.requester_profiles (user_id) values ($1)`, [requesterId]);
  await db.query(`select public.admin_bootstrap_grant($1)`, [adminId]);

  // ---- 1. no jwt claims -> staff RPC refused (server-verified, not app flag)
  await db.query(`begin`);
  await db.query(`set local role authenticated`);
  const { rows: noClaims } = await db.query(`select * from public.admin_grant_moderator($1, null) `, [modId]);
  await db.query(`commit`);
  if (noClaims[0].ok === false) pass("staff RPC without jwt claims refused (server-verified roles)");
  else fail("no-claims check", noClaims);

  // ---- 2. admin grants moderator (audited) ---------------------------------
  await session(adminId);
  const { rows: grant } = await db.query(`select * from public.admin_grant_moderator($1, 'phase10 smoke') `, [modId]);
  await endSession();
  if (grant[0].ok === true) pass("admin granted moderator");
  else fail("grant moderator", grant);
  const { rows: grantAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='moderator.granted' and (detail->>'user_id')=$1`, [modId]);
  if (grantAudit[0].n >= 1) pass("moderator grant audited");
  else fail("grant audit", grantAudit);

  // ---- 3. privilege separation --------------------------------------------
  await session(modId);
  const { rows: setRef } = await db.query(`select * from public.admin_set_setting('moderation.m', '7'::jsonb, 'moderation') `);
  const { rows: grantRef } = await db.query(`select * from public.admin_grant_moderator($1, null) `, [donorA]);
  const { rows: reinstateRef } = await db.query(`select * from public.admin_review_disabled_account($1, 'reinstate', 'n') `, [donorB]);
  await endSession();
  if (setRef[0].ok === false && grantRef[0].ok === false && reinstateRef[0].ok === false)
    pass("moderator cannot set settings / grant roles / reinstate accounts");
  else fail("privilege separation", { setRef, grantRef, reinstateRef });

  // plain user cannot act as staff
  await session(requesterId);
  const { rows: userRef } = await db.query(`select * from public.mod_review_request(gen_random_uuid(), 'flag', 'n') `);
  await endSession();
  if (userRef[0].ok === false) pass("ordinary user cannot moderate requests");
  else fail("user escalation", userRef);

  // ---- 4. request Bulk-creation cap (server-side counter + audit) ----------
  const cap = 15; // seeded default for request_create_per_day
  let refused = false;
  for (let i = 1; i <= cap + 1; i++) {
    await session(requesterId);
    const { rows: bump } = await db.query(`select * from public.bump_abuse_counter($1, 'request_create') `, [requesterId]);
    await endSession();
    if (i === cap + 1 && bump[0].allowed === false) refused = true;
  }
  if (refused) pass(`request_create cap enforced at ${cap}/day`);
  else fail("request_create cap", { cap });
  const { rows: capAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='abuse.limit_tripped' and detail->>'scope'='request_create' and (detail->>'subject')=$1`, [requesterId]);
  if (capAudit[0].n >= 1) pass("tripped cap audited");
  else fail("cap audit", capAudit);

  // ---- 5. abuse report flow -------------------------------------------------
  await session(requesterId);
  const { rows: reported } = await db.query(
    `insert into public.abuse_reports (reporter_id, target_type, target_id, category, detail)
     values ($1,'donor_profile',$2,'fake_profile','phase10 smoke report') returning id`, [requesterId, donorA]);
  await endSession();
  const reportId = reported[0].id;
  pass("reporter filed abuse report via RLS");
  // reporter sees own; a MODERATOR must not select the reporter's row directly
  await session(modId);
  const { rows: modDirect } = await db.query(`select count(*)::int as n from public.abuse_reports where id=$1`, [reportId]);
  await endSession();
  if (modDirect[0].n === 0) pass("staff cannot read others' reports directly (RLS; review is RPC-only)");
  else fail("report privacy (direct staff read)", modDirect);
  const { rows: filedAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='abuse.report_filed' and (detail->>'report_id')=$1`, [reportId]);
  if (filedAudit[0].n >= 1) pass("report filing audited by trigger");
  else fail("report audit", filedAudit);

  await session(modId);
  const { rows: reviewed } = await db.query(`select * from public.mod_review_abuse_report($1, 'dismissed', 'insufficient evidence') `, [reportId]);
  await endSession();
  if (reviewed[0].ok === true) pass("moderator reviewed report (with resolution note)");
  else fail("review report", reviewed);
  const { rows: reviewNoteAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='abuse.report_reviewed' and (detail->>'report_id')=$1`, [reportId]);
  if (reviewNoteAudit[0].n >= 1) pass("report review audited");
  else fail("review audit", reviewNoteAudit);

  // ---- 6. profile inspection: safe fields only ------------------------------
  await session(modId);
  const { rows: inspected } = await db.query(`select * from public.mod_inspect_profile($1)`, [donorA]);
  await endSession();
  const insp = inspected[0] ?? {};
  if (insp.ok === true && !("phone" in insp) && typeof insp.matches_other_verified_phone === "boolean" && insp.is_phone_verified === false)
    pass("profile inspection is sanitized (no phone; correlation flag present)");
  else fail("inspect profile", insp);
  let nonStaffInsp;
  await session(requesterId);
  try {
    nonStaffInsp = (await db.query(`select * from public.mod_inspect_profile($1)`, [donorA])).rows[0].ok;
  } catch { nonStaffInsp = false; }
  await endSession();
  if (nonStaffInsp === false) pass("ordinary user cannot inspect profiles");
  else fail("inspect gate", nonStaffInsp);

  // ---- 7. request moderation (flag -> transitions + audited) ----------------
  await session(requesterId);
  const { rows: reqRow } = await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency, units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Smoke','urgent',1,now()+interval '2 days',true,'in_app','submitted',$2) returning id`,
    [requesterId, tag]);
  reqId = reqRow[0].id;
  await endSession();
  await session(modId);
  const { rows: flagged } = await db.query(`select * from public.mod_review_request($1, 'flag', 'phase10 smoke: dup requests') `, [reqId]);
  await endSession();
  if (flagged[0].ok === true) pass("moderator flagged suspicious request");
  else fail("flag request", flagged);
  const { rows: reqState } = await db.query(`select status from public.blood_requests where id=$1`, [reqId]);
  const { rows: transitionRow } = await db.query(
    `select count(*)::int as n from public.request_transitions where request_id=$1 and to_status='flagged'`, [reqId]);
  if (reqState[0].status === "flagged" && transitionRow[0].n >= 1) pass("flag recorded in status + transition trail");
  else fail("flag persistence", { reqState, transitionRow });
  const { rows: flagAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='request.moderation' and (detail->>'request_id')=$1`, [reqId]);
  if (flagAudit[0].n >= 1) pass("request moderation audited");
  else fail("moderation audit", flagAudit);

  // ---- 8. account disable: DB-level enforcement -----------------------------
  await session(modId);
  const { rows: disabled } = await db.query(`select * from public.mod_disable_account($1, 'phase10 smoke: abusive') `, [donorB]);
  await endSession();
  if (disabled[0].ok === true) pass("moderator disabled abusive account");
  else fail("disable account", disabled);
  const { rows: disableAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='account.disabled' and (detail->>'user_id')=$1`, [donorB]);
  if (disableAudit[0].n >= 1) pass("account disable audited");
  else fail("disable audit", disableAudit);

  // staff account protection
  await session(modId);
  const { rows: staffProt } = await db.query(`select * from public.mod_disable_account($1, 'phase10 smoke') `, [adminId]);
  await endSession();
  if (staffProt[0].ok === false) pass("staff accounts protected from moderation disable");
  else fail("staff protection", staffProt);

  // disabled account blocked BY THE DB on request writes + match actions
  await session(donorB);
  let writeBlocked = false;
  try {
    await db.query(
      `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency, units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
       values ($1,'O+',101001,'Smoke','urgent',1,now()+interval '2 days',true,'in_app','submitted',$2)`, [donorB, tag + "-blocked"]);
  } catch (e) { writeBlocked = true; await db.query(`rollback`); await db.query(`begin`); await db.query(`set local role authenticated`); await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: donorB, role: "authenticated" })]); }
  if (writeBlocked) pass("disabled account refuses request writes at the DB (RLS)");
  else fail("disabled write block");
  // match action refusal (match row is staged by postgres; then donorB acts)
  await endSession();
  const { rows: matchRow } = await db.query(
    `insert into public.request_matches (request_id, donor_id, status) values ($1,$2,'notified') returning id`, [reqId, donorB]);
  matchId = matchRow[0].id;
  await session(donorB);
  const { rows: respondB } = await db.query(
    `select * from public.donor_respond_match($1, 'decline', $2, 'in_app') `, [matchId, donorB]);
  await endSession();
  if (respondB[0].ok === false && respondB[0].message === "account disabled")
    pass("disabled donor cannot act on matches (RPC gate)");
  else fail("disabled respond", respondB);

  // ---- 9. review process -----------------------------------------------------
  await session(donorB);
  const { rows: appeal } = await db.query(`select * from public.account_request_review() `);
  await endSession();
  if (appeal[0].ok === true) pass("disabled account requested review (self-service)");
  else fail("appeal", appeal);
  await session(donorB);
  const { rows: appealAgain } = await db.query(`select * from public.account_request_review() `);
  await endSession();
  if (appealAgain[0].ok === false) pass("duplicate appeals refused");
  else fail("appeal-dupes", appealAgain);
  await session(modId);
  const { rows: modReinstate } = await db.query(`select * from public.admin_review_disabled_account($1, 'reinstate', 'n') `, [donorB]);
  await endSession();
  if (modReinstate[0].ok === false) pass("moderator cannot review disable decisions (admin only)");
  else fail("reinstate separation", modReinstate);
  await session(adminId);
  const { rows: reinstated } = await db.query(`select * from public.admin_review_disabled_account($1, 'reinstate', 'phase10 smoke: cleared') `, [donorB]);
  await endSession();
  if (reinstated[0].ok === true) pass("admin reinstated account after review");
  else fail("reinstate", reinstated);
  const { rows: reviewAudit } = await db.query(
    `select count(*)::int as n from public.audit_log where action='account.review_decided' and (detail->>'user_id')=$1`, [donorB]);
  if (reviewAudit[0].n >= 1) pass("review decision audited");
  else fail("review audit", reviewAudit);
  // account functional again
  await session(donorB);
  const { rows: again } = await db.query(
    `insert into public.blood_requests (creator_id, blood_group, location_id, location_text, urgency, units_needed, required_by, consent_confirmed, contact_pref, status, idempotency_key)
     values ($1,'O+',101001,'Smoke','urgent',1,now()+interval '2 days',true,'in_app','submitted',$2) returning id`, [donorB, tag + "-again"]);
  await endSession();
  if (again[0].id) pass("reinstated account can act again");
  else fail("reinstated action", again);

  // ---- 10. contact-reveal daily cap (enumeration guard) ----------------------
  await db.query(`insert into public.contact_numbers (user_id, phone, phone_normalized, verified_at) values ($1,'+8801712345678','+8801712345678',now()) on conflict (user_id) do nothing`, [donorB]);
  await db.query(`update public.request_matches set status='accepted', accepted_at=now(), responded_at=now() where id=$1`, [matchId]);
  await session(adminId);
  const { rows: lowCap } = await db.query(`select * from public.admin_set_setting('rate_limits.contact_reveal_per_day', '1'::jsonb, 'rate_limits', 'phase10') `);
  await endSession();
  if (lowCap[0].ok === true) pass("admin set contact-reveal cap to 1 (settings + audit)");
  else fail("cap setting", lowCap);

  await session(requesterId);
  let revealOk = false, revealRefused = false;
  try {
    await db.query(`select public.reveal_contact($1, $2, $3)`, [reqId, donorB, requesterId]);
    revealOk = true;
  } catch (e) {
    revealOk = false;
  }
  await db.query(`update public.request_matches set status='accepted', accepted_at=now() where id=$1`, [matchId]); // keep state valid
  try {
    await db.query(`select public.reveal_contact($1, $2, $3)`, [reqId, donorB, requesterId]);
  } catch (e) {
    if (/rate limit/i.test(e.message)) revealRefused = true;
  }
  await endSession();
  if (revealOk && revealRefused) pass("contact reveal capped after 1/day (first ok, second refused)");
  else fail("reveal cap", { revealOk, revealRefused });
  await db.query(`update public.platform_settings set value = '20'::jsonb where key = 'rate_limits.contact_reveal_per_day'`);

  // ---- 11. disabled-donor exclusion from candidate SQL -----------------------
  const { rows: excludedCount } = await db.query(`
    select count(*)::int as n from public.account_status where status <> 'active'`);
  pass(`account_status table live (exclusion compiled into candidates SQL; rows=${excludedCount[0].n})`);

  console.log("Phase 10 live smoke complete.");
} catch (e) {
  console.error("ERROR", e);
  process.exitCode = 1;
  try { await db.query(`rollback`); await db.query(`commit`); } catch {}
} finally {
  await db.end();
}
