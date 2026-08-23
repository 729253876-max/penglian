import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["../test-network-policy/vitest.network-policy.ts"]
  }
});
