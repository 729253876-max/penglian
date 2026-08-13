import { describe, expect, it } from "vitest";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { ApiConfig } from "../src/config.js";
import { buildProductionApp } from "../src/server.js";

const config: ApiConfig = {
  nodeEnv: "test",
  acceptanceMode: false,
  accessTokenLifetimeMilliseconds: 7_200_000,
  host: "127.0.0.1",
  port: 3100,
  mysqlUrl: "mysql://fictional-user:fictional-password@localhost/fictional-db",
  wechatAppId: "wx-fictional-app-id",
  wechatAppSecret: "fictional-app-secret",
  identityLookupKey: Buffer.alloc(32, 1),
  identityEncryptionKey: Buffer.alloc(32, 2)
};

describe("production app assembly", () => {
  it("reads an approved MySQL asset but fails preview when no provider is configured", async () => {
    const app = buildProductionApp(config, { pool: productionPool() });
    const headers = { authorization: "Bearer production-token" };

    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers,
        payload: {
          tool: "PORTRAIT_RETOUCH",
          inputAssetId: "demo-portrait-001",
          direction: "NATURAL_RESCUE",
          parameters: { naturalness: 85, detailLevel: 35 }
        }
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ status: "AWAITING_CONFIRMATION" });

      const preview = await app.inject({
        method: "POST",
        url: `/v1/tasks/${created.json().taskId}/preview`,
        headers
      });
      expect(preview.statusCode).toBe(202);
      expect(preview.json()).toMatchObject({
        status: "FAILED",
        failureCode: "PREVIEW_PROVIDER_FAILED",
        noCharge: true
      });
      expect(preview.json()).not.toHaveProperty("previewUrl");

      const events = await app.inject({
        method: "GET",
        url: `/v1/tasks/${created.json().taskId}/events?afterSequence=0`,
        headers
      });
      expect(events.json().items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ evidenceSource: "PROVIDER_RECEIPT" })
      ]));
    } finally {
      await app.close();
    }
  });
});

function productionPool(): Pool {
  const execute = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM sessions s")) {
      return [[{
        id: "session-1",
        user_id: "user-1",
        device_id_hash: Buffer.alloc(32),
        access_token_hash: Buffer.alloc(32),
        access_expires_at: new Date("2030-01-01T00:00:00.000Z"),
        refresh_token_hash: Buffer.alloc(32),
        refresh_expires_at: new Date("2030-01-02T00:00:00.000Z"),
        last_used_at: new Date("2029-01-01T00:00:00.000Z"),
        revoked_at: null
      }] as RowDataPacket[], []];
    }
    if (sql.includes("FROM assets a")) {
      expect(values).toEqual(["demo-portrait-001", "user-1"]);
      return [[{
        asset_id: "demo-portrait-001",
        user_id: "user-1",
        upload_session_id: "upload-1",
        object_key: "users/user-1/upload-1/normalized",
        width: 2400,
        height: 3200,
        quality_warning: 1
      }] as RowDataPacket[], []];
    }
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  };
  const connection = {
    execute,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined
  } as unknown as PoolConnection;
  return {
    execute,
    getConnection: async () => connection,
    end: async () => undefined
  } as unknown as Pool;
}
