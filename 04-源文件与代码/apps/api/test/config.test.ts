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

  it("rejects identity keys that are not 32-byte hexadecimal values", () => {
    expect(() =>
      loadConfig({ ...validProductionEnv, IDENTITY_LOOKUP_KEY: "11".repeat(31) })
    ).toThrow("INVALID_IDENTITY_LOOKUP_KEY");
  });
});
