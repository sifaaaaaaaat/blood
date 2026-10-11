/**
 * dev-only: apply phase-2 migration to a Supabase Postgres database and verify
 * the result. Reads SUPABASE_DB_PASSWORD from .env.local. Never logs secrets.
 *
 * Usage:
 *   node scripts/apply-migration.mjs            (apply + verify)
 *   node scripts/apply-migration.mjs --verify   (verify only)
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const verifyOnly = process.argv.includes("--verify");
const sqlPath = path.resolve(
  process.env.MIGRATION_FILE || "supabase/migrations/0001_phase2_foundation.sql"
);

// --- load env from .env.local (no dotenv dependency) ------------------------
const envText = fs.readFileSync(path.resolve(".env.local"), "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    })
);

const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL).hostname;
const projectRef = host.split(".")[0];
const password = env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error("SUPABASE_DB_PASSWORD missing in .env.local — refusing to continue");
  process.exit(1);
}
if (!verifyOnly) {
  const sql = fs.readFileSync(sqlPath, "utf8");
  if (!/\bbegin\s*;/i.test(sql) || !/\bcommit\s*;/i.test(sql)) {
    console.error("migration file must be wrapped in begin/commit — aborting");
    process.exit(1);
  }
}

const client = new Client({
  // Supavisor session-mode pooler (port 5432). Used because this dev machine's
  // resolver cannot resolve the direct db.<ref>.supabase.co host (ENOTFOUND),
  // while the pooler DNS entry resolves normally. The pooler is the
  // Supabase-recommended path anyway and does not change SQL semantics.
  host: env.SUPABASE_DB_HOST || "aws-0-ap-south-1.pooler.supabase.com",
  port: Number(env.SUPABASE_DB_PORT || 5432),
  database: "postgres",
  user: `postgres.${projectRef}`,
  password,
  ssl: { rejectUnauthorized: false },
});

async function verify() {
  const expectations = [];
  const check = (label, ok) => {
    expectations.push(`${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) process.exitCode = 1;
  };

  const { rows: tables } = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`
  );
  const names = tables.map((r) => r.table_name);
  for (const t of ["profiles", "donor_profiles", "requester_profiles",
    "contact_numbers", "divisions", "districts", "upazilas", "audit_log"]) {
    check(`table ${t} exists`, names.includes(t));
  }

  const { rows: enums } = await client.query(
    `select typname from pg_type where typname in ('blood_group','donor_availability','request_urgency')`
  );
  check(`3 enums exist (${enums.length}/3)`, enums.length === 3);

  const { rows: rls } = await client.query(
    `select c.relname, c.relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'`
  );
  for (const r of rls) {
    check(`RLS enabled on ${r.relname}`, r.relrowsecurity === true);
  }

  // Phase 2 design: 14 policies. Phase 3 adds 1 (notification_consents RLS).
  // Track the exact expected set so a missing/extra policy is caught:
  const EXPECTED = 14 + 1;
  const { rows: policies } = await client.query(
    `select count(*)::int as n from pg_policies where schemaname = 'public'`
  );
  check(`RLS policies present (${policies[0].n}/${EXPECTED})`, policies[0].n === EXPECTED);

  const { rows: triggers } = await client.query(
    `select count(*)::int as n from information_schema.triggers
     where trigger_name in ('on_auth_user_created','profiles_touch',
       'donor_profiles_touch','contact_numbers_touch','requester_profiles_touch')`
  );
  check(`5 triggers present (${triggers[0].n}/5)`, triggers[0].n === 5);

  const { rows: fn } = await client.query(
    `select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname in
     ('admin_bootstrap_grant','append_audit_log','touch_updated_at','handle_new_user')`
  );
  check(`4 functions present (${fn[0].n}/4)`, fn[0].n === 4);

  // no admin promotion via authenticated role
  const { rows: acl } = await client.query(
    `select count(*)::int as n from information_schema.routine_privileges
     where routine_schema='public' and routine_name='admin_bootstrap_grant'
     and grantee in ('anon','authenticated')`
  );
  check(`admin_bootstrap_grant hidden from anon/authenticated`, acl[0].n === 0);

  console.log(expectations.join("\n"));
}

try {
  await client.connect();
  console.log("connected to Supabase Postgres");

  if (verifyOnly) {
    await verify();
  } else {
    const sql = fs.readFileSync(sqlPath, "utf8");
    await client.query(sql);
    console.log("migration 0001 applied");
    await verify();
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
