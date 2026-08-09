import { describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import type { ApiConfig } from "../src/config.js";
import { createMySqlReadiness } from "../src/infrastructure/mysql-readiness.js";
import { buildProductionApp } from "../src/server.js";

const productionTestConfig: ApiConfig = {
  nodeEnv: "test",
  acceptanceMode: false,
  accessTokenLifetimeMilliseconds: 2 * 60 * 60 * 1000,
  host: "127.0.0.1",
  port: 3100,
  mysqlUrl: "mysql://fictional-user:fictional-password@localhost/fictional-db",
  wechatAppId: "wx-fictional-app-id",
  wechatAppSecret: "fictional-app-secret",
  identityLookupKey: Buffer.alloc(32, 1),
  identityEncryptionKey: Buffer.alloc(32, 2)
};

describe("MySQL readiness", () => {
  it("passes a bounded timeout to the MySQL readiness query", async () => {
    const calls: unknown[] = [];
    const readiness = createMySqlReadiness({
      query: async (options: unknown) => {
        calls.push(options);
        return [[], []];
      }
    });

    await readiness.check();

    expect(calls).toEqual([{ sql: "SELECT 1", timeout: 1500 }]);
  });

  it("passes an explicit timeout to the MySQL readiness query", async () => {
    const calls: unknown[] = [];
    const readiness = createMySqlReadiness({
      query: async (options: unknown) => {
        calls.push(options);
        return [[], []];
      }
    }, 250);

    await readiness.check();

    expect(calls).toEqual([{ sql: "SELECT 1", timeout: 250 }]);
  });

  it("wires the bounded readiness query into the production app", async () => {
    const calls: unknown[] = [];
    const pool = {
      query: async (options: unknown) => {
        calls.push(options);
        return [[], []];
      }
    } as unknown as Pool;
    const app = buildProductionApp(productionTestConfig, { pool });

    try {
      const response = await app.inject({ method: "GET", url: "/health/ready" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      expect(calls).toEqual([{ sql: "SELECT 1", timeout: 1500 }]);
    } finally {
      await app.close();
    }
  });
});
