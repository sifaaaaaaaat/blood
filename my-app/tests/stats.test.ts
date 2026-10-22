import { afterEach, describe, expect, it } from "vitest";
import { getPlatformStats } from "@/src/lib/services/stats";

/**
 * Phase 11B — homepage stats must degrade to an honest pending state (null),
 * never fabricate figures, when the database is not reachable/configured.
 * Vitest does not load .env.local, so the Supabase env vars are absent here —
 * exactly the "no database" scenario.
 */
describe("getPlatformStats", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns null (pending state) when the database client cannot be created", async () => {
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const stats = await getPlatformStats();
    expect(stats).toBeNull();
  });

  it("returns null (pending state) when the database is unreachable", async () => {
    savedEnv["NEXT_PUBLIC_SUPABASE_URL"] = process.env["NEXT_PUBLIC_SUPABASE_URL"];
    savedEnv["SUPABASE_SERVICE_ROLE_KEY"] = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://unreachable.invalid.supabase.co";
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = "stub-service-key";

    const stats = await getPlatformStats();
    expect(stats).toBeNull();
  });
});
