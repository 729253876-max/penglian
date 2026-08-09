import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildRuntimeConfig } = require("../scripts/generate-runtime-config.cjs") as {
  buildRuntimeConfig(environment: Record<string, string | undefined>): {
    mode: "local" | "acceptance" | "production";
    apiBase: string;
  };
};

describe("runtime config generator", () => {
  it("requires an explicit API base when invoked from the environment", () => {
    const environment = {
      ...process.env,
      PHOTO_AI_APP_MODE: "local"
    };
    delete environment.PHOTO_AI_API_BASE;

    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/generate-runtime-config.cjs", import.meta.url)),
      "--from-env"
    ], {
      encoding: "utf8",
      env: environment
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INVALID_PHOTO_AI_API_BASE");
  });

  it("uses localhost only in local mode", () => {
    expect(buildRuntimeConfig({ PHOTO_AI_APP_MODE: "local" })).toEqual({
      mode: "local",
      apiBase: "http://127.0.0.1:3100"
    });
  });

  it("allows a private LAN origin for acceptance", () => {
    expect(buildRuntimeConfig({
      PHOTO_AI_APP_MODE: "acceptance",
      PHOTO_AI_API_BASE: "http://192.168.1.20:3100/"
    })).toEqual({
      mode: "acceptance",
      apiBase: "http://192.168.1.20:3100"
    });
  });

  it("allows an HTTPS origin for acceptance or production", () => {
    expect(buildRuntimeConfig({
      PHOTO_AI_APP_MODE: "acceptance",
      PHOTO_AI_API_BASE: "https://acceptance.example.com/"
    })).toEqual({
      mode: "acceptance",
      apiBase: "https://acceptance.example.com"
    });
    expect(buildRuntimeConfig({
      PHOTO_AI_APP_MODE: "production",
      PHOTO_AI_API_BASE: "https://api.example.com"
    })).toEqual({
      mode: "production",
      apiBase: "https://api.example.com"
    });
  });

  it.each([
    ["acceptance", "http://127.0.0.1:3100"],
    ["acceptance", "http://example.com"],
    ["production", "http://192.168.1.20:3100"],
    ["production", "https://user:pass@example.com"],
    ["production", "https://example.com/path"]
  ])("rejects an unsafe %s API origin", (mode, apiBase) => {
    expect(() => buildRuntimeConfig({
      PHOTO_AI_APP_MODE: mode,
      PHOTO_AI_API_BASE: apiBase
    })).toThrow("INVALID_PHOTO_AI_API_BASE");
  });

  it.each([
    [{}, "INVALID_PHOTO_AI_APP_MODE"],
    [{ PHOTO_AI_APP_MODE: "staging" }, "INVALID_PHOTO_AI_APP_MODE"],
    [{ PHOTO_AI_APP_MODE: "acceptance" }, "INVALID_PHOTO_AI_API_BASE"],
    [{
      PHOTO_AI_APP_MODE: "acceptance",
      PHOTO_AI_API_BASE: "not-a-url"
    }, "INVALID_PHOTO_AI_API_BASE"]
  ])("rejects incomplete or malformed environment input", (environment, error) => {
    expect(() => buildRuntimeConfig(environment)).toThrow(error);
  });
});
