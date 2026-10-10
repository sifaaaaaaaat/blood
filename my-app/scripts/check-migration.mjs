import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/0001_phase2_foundation.sql", "utf8");
const errs = [];

// 1. $$ blocks balanced
const dollars = (sql.match(/\$\$/g) || []).length;
if (dollars % 2 !== 0) errs.push(`unbalanced $$ blocks: ${dollars}`);

// 2. RLS enabled on every public table we create
const tables = [
  "profiles", "donor_profiles", "requester_profiles", "contact_numbers",
  "divisions", "districts", "upazilas", "audit_log",
];
for (const t of tables) {
  if (!sql.includes(`alter table public.${t}    enable row level security`) &&
      !sql.match(new RegExp(`alter table public\\.${t}\\s+enable row level security`))) {
    errs.push(`RLS not enabled on ${t}`);
  }
  if (!new RegExp(`create policy\\s+\\w+\\s+on\\s+public\\.${t}\\b`).test(sql)) {
    errs.push(`no policy created on ${t}`);
  }
}

// 3. Core functions/triggers present
if (!sql.includes("on_auth_user_created")) errs.push("missing handle_new_user trigger");
if (!sql.includes("admin_bootstrap_grant")) errs.push("missing admin bootstrap function");
if (!sql.includes("append_audit_log")) errs.push("missing audit log function");

// 4. No admin-promotion path via authenticated role
const grantFn = sql.split("create or replace function public.admin_bootstrap_grant")[1] ?? "";
if (!/revoke execute on function public\.admin_bootstrap_grant/.test(sql)) {
  errs.push("admin bootstrap function not revoked from anon/authenticated");
}

if (errs.length) {
  console.error("migration self-check FAILED:");
  for (const e of errs) console.error(" -", e);
  process.exit(1);
}
console.log("migration self-check passed");
