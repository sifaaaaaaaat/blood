import fs from "node:fs";
import { Client } from "pg";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const file = process.argv[2];
const sql = fs.readFileSync(file, "utf8")
  .split(/\r?\n/)
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

// handle $$ blocks and strings; collect statements
const stmts = [];
let cur = "", inDollar = false;
for (let i = 0; i < sql.length; i++) {
  const two = sql.slice(i, i + 2);
  if (two === "$$") { inDollar = !inDollar; cur += two; i++; continue; }
  if (sql[i] === ";" && !inDollar) { stmts.push(cur.trim()); cur = ""; continue; }
  cur += sql[i];
}
if (cur.trim()) stmts.push(cur.trim());

const batchUp = (rows, table) => {
  if (!rows.length) return null;
  return `insert into ${table} values ${rows.join(",")};`;
};

const groups = { upazilas: [], upazila_geo: [], upazila_adjacency: [], districts: [], divisions: [] };
const final = [];
for (const s of stmts.filter(Boolean)) {
  const m = /^insert into (public\.\w+)/.exec(s);
  if (m && groups[m[1].split(".")[1]]) {
    const t = m[1].split(".")[1];
    const valuesPart = s.slice(s.indexOf(" values ") + 8).replace(/;$/, "");
    groups[t].push(valuesPart);
  } else {
    final.push(s);
  }
}

const c = new Client({
  host: env.SUPABASE_DB_HOST, port: +env.SUPABASE_DB_PORT,
  user: "postgres." + new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0],
  password: env.SUPABASE_DB_PASSWORD, database: "postgres",
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const t0 = Date.now();
const ordered = ["divisions", "districts", "upazilas", "upazila_geo", "upazila_adjacency"];
let n = 0;
try {
  await c.query("begin");
  for (const s of final) {
    if (n === 4) {
      console.log("=== stmt after 5:");
      console.log(final[4] ?? final[final.length-1] ?? "(none)");
    }
    if (/^truncate/i.test(s)) { await c.query(s); n++; continue; }
    if (/^begin$|^commit$/i.test(s)) continue;
    if (/^insert/.test(s)) { continue; } // moved into batches below
    await c.query(s); n++;
  }
  for (const t of ordered) {
    const b = batchUp(groups[t], "public." + t);
    if (!b) continue;
    // chunk to avoid enormous statements
    const rows = groups[t];
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await c.query(`insert into public.${t} values ${rows.slice(i, i + CHUNK).join(",")}`);
      n++;
    }
  }
  await c.query("commit");
  console.log("done, statements:", n, "in", Date.now() - t0, "ms");
} catch (e) {
  await c.query("rollback");
  console.log("FAILED after", n, "statements:", e.message);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
} finally {
  await c.end();
}
