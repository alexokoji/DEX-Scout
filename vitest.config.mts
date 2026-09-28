import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { MOCK_PROVIDER: "true" },
    setupFiles: ["dotenv/config"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});