import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "apps/api/vitest.config.ts",
  "apps/miniprogram/vitest.config.ts"
]);
