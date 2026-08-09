import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validProductionEnv = {
  NODE_ENV: "production",
  PORT: "8080",
  MYSQL_URL: "mysql://u:p@db/app",
  WECHAT_APP_ID: "wx4f7678cc595d276b",
  WECHAT_APP_SECRET: "secret",
  IDENTITY_LOOKUP_KEY: "11".repeat(32),
  IDENTITY_ENCRYPTION_KEY: "22".repeat(32)
} as const;

describe("loadConfig", () => {
  it("keeps the two-hour access lifetime outside acceptance mode", () => {
    expect(loadConfig(validProductionEnv)).toMatchObject({
      acceptanceMode: false,
      accessTokenLifetimeMilliseconds: 2 * 60 * 60 * 1000
    });
  });

  it("allows a bounded short access lifetime only in non-production acceptance mode", () => {
    expect(loadConfig({
      ...validProductionEnv,
      NODE_ENV: "test",
      ACCEPTANCE_MODE: "1",
      ACCEPTANCE_ACCESS_TTL_SECONDS: "60"
    })).toMatchObject({
      acceptanceMode: true,
      host: "0.0.0.0",
      accessTokenLifetimeMilliseconds: 60_000
    });
  });

  it.each([
    [{ ...validProductionEnv, NODE_ENV: "test", ACCEPTANCE_MODE: "yes" }, "INVALID_ACCEPTANCE_MODE"],
    [{ ...validProductionEnv, ACCEPTANCE_MODE: "1", ACCEPTANCE_ACCESS_TTL_SECONDS: "60" }, "ACCEPTANCE_MODE_FORBIDDEN_IN_PRODUCTION"],
    [{ ...validProductionEnv, NODE_ENV: "test", ACCEPTANCE_MODE: "1", ACCEPTANCE_ACCESS_TTL_SECONDS: "29" }, "INVALID_ACCEPTANCE_ACCESS_TTL_SECONDS"],
    [{ ...validProductionEnv, NODE_ENV: "test", ACCEPTANCE_MODE: "1", ACCEPTANCE_ACCESS_TTL_SECONDS: "601" }, "INVALID_ACCEPTANCE_ACCESS_TTL_SECONDS"],
    [{ ...validProductionEnv, NODE_ENV: "test", ACCEPTANCE_ACCESS_TTL_SECONDS: "60" }, "ACCEPTANCE_TTL_WITHOUT_MODE"]
  ])("rejects unsafe acceptance configuration", (env, code) => {
    expect(() => loadConfig(env)).toThrow(code);
  });

  it("binds a fully configured production API to all interfaces", () => {
    const config = loadConfig(validProductionEnv);

    expect(config).toMatchObject({
      nodeEnv: "production",
      host: "0.0.0.0",
      port: 8080,
      mysqlUrl: "mysql://u:p@db/app",
      wechatAppId: "wx4f7678cc595d276b",
      wechatAppSecret: "secret"
    });
    expect(config.identityLookupKey).toEqual(Buffer.from("11".repeat(32), "hex"));
    expect(config.identityEncryptionKey).toEqual(Buffer.from("22".repeat(32), "hex"));
  });

  it("rejects a placeholder WeChat application ID", () => {
    expect(() =>
      loadConfig({ ...validProductionEnv, WECHAT_APP_ID: "touristappid" })
    ).toThrow("INVALID_WECHAT_APP_ID");
  });

  it("rejects a format-valid App ID that is not this production application", () => {
    expect(() =>
      loadConfig({ ...validProductionEnv, WECHAT_APP_ID: "wx0000000000000000" })
    ).toThrow("INVALID_WECHAT_APP_ID");
  });

  it("rejects identity keys that are not 32-byte hexadecimal values", () => {
    expect(() =>
      loadConfig({ ...validProductionEnv, IDENTITY_LOOKUP_KEY: "11".repeat(31) })
    ).toThrow("INVALID_IDENTITY_LOOKUP_KEY");
  });

  it("rejects an encryption key that is not a 32-byte hexadecimal value", () => {
    expect(() =>
      loadConfig({ ...validProductionEnv, IDENTITY_ENCRYPTION_KEY: "22".repeat(31) })
    ).toThrow("INVALID_IDENTITY_ENCRYPTION_KEY");
  });

  it("rejects identical lookup and encryption keys", () => {
    expect(() =>
      loadConfig({
        ...validProductionEnv,
        IDENTITY_ENCRYPTION_KEY: validProductionEnv.IDENTITY_LOOKUP_KEY
      })
    ).toThrow("IDENTITY_KEYS_MUST_DIFFER");
  });
});
