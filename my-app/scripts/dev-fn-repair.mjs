import fs from "node:fs";
import { Client } from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const c = new Client({
  host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT,
  user: "postgres." + new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0],
  password: env.SUPABASE_DB_PASSWORD, database: "postgres",
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const fnSQL = fs.readFileSync("supabase/migrations/0005_phase5_matching_rpc.sql", "utf8");
await c.query(fnSQL);
console.log("0005 file applied — checking shapes");

const { rows: shapes } = await c.query(`
  select p.proname, pg_get_function_result(p.oid) as result
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'exec_%'`);
console.log(shapes);

const q = `select dp.user_id, p.display_name, dp.blood_group::text, u.name, d.name, dp.availability::text, 1 as tier
   from public.donor_profiles dp
   join public.profiles p on p.id = dp.user_id
   join public.upazilas u on u.id = dp.upazila_id
   join public.districts d on d.id = u.district_id
   join public.contact_numbers cn on cn.user_id = dp.user_id
  where dp.blood_group::text = 'O+' and dp.availability = 'available'
    and dp.notify_consent = true and cn.verified_at is not null
  limit 3`;

const { data: none, rows: match } = await c.query("select * from public.exec_matching_sql($1::text)", [q]);
console.log("matching rows:", (match || (none)).length ?? "err");

const evil = await c.query("select * from public.exec_matching_sql($1::text)", [
  q.replace("dp.availability::text", "cn.phone as availability::text"),
]).catch((e) => ({ error: e }));
console.log("phone smuggle:", evil.error ? "refused (" + evil.error.message.slice(0, 60) + ")" : "returned " + evil.rows?.length + " rows");

const loc = await c.query("select * from public.exec_location_sql($1::text)", ["select district_id, name from public.upazilas where id = 1"]);
console.log("loc rows:", loc.rows?.length ?? "err", loc.error?.message || "");

await c.end();
