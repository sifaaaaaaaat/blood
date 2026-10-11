import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // 'server-only' is a Next.js compile-time guard; tests run outside Next,
      // so map it to an empty module instead of failing resolution.
      "server-only": path.resolve(__dirname, "tests/server-only-stub.ts"),
    },
  },
});
