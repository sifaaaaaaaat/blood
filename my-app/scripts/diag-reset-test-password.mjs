import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

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

const projectRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const client = new Client({
  host: env.SUPABASE_DB_HOST || "aws-0-ap-south-1.pooler.supabase.com",
  port: Number(env.SUPABASE_DB_PORT || 5432),
  database: "postgres",
  user: `postgres.${projectRef}`,
  password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const email = "login-fix-check@rokto.test";
// Matches Supabase's default bcrypt cost (10) — same scheme auth uses.
const newPassword = "RoktoTest#2026";

try {
  await client.connect();
  const { rows, rowCount } = await client.query(
    `update auth.users set encrypted_password = crypt($1, gen_salt('bf', 10))
     where email = $2 returning id, email`,
    [newPassword, email]
  );
  console.log("updated rows:", rowCount, rows.map((r) => r.email));

  if (rowCount) {
    const { rows: sessions } = await client.query(
      `delete from auth.sessions where user_id in (select id from auth.users where email = $1) returning id`,
      [email]
    );
    console.log("stale sessions cleared:", sessions.length);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
