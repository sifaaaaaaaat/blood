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

const q = "select 1 as tier\n from public.donor_profiles limit 1";

// JS string built to hold backslash + s exactly:
const pattern = "\\s+";
console.log("pattern JS literal:", JSON.stringify(pattern));
const { rows } = await c.query(
  "select lower(regexp_replace(trim($1::text), $2::text, ' ', 'g')) as lowered",
  [q, pattern]
);
console.log("lowered:", JSON.stringify(rows[0].lowered));
await c.end();
