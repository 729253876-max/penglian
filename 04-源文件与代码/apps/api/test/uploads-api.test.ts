import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { UploadApiService } from "../src/routes/uploads.js";
import { buildProductionApp } from "../src/server.js";
import { MockObjectStorage } from "../src/infrastructure/mock-object-storage.js";

function buildUploadApp(service: UploadApiService) {
  return buildApp({
    uploadService: service,
    sessionAuthenticator: { authenticate: async (token) => ({ userId: token === "owner" ? "user-1" : "user-2" }) }
  });
}

class MemoryUploadApiService implements UploadApiService {
  public providerCalls = 0;
  public async createSession(userId: string) {
    return {
      sessionId: "11111111-1111-4111-8111-111111111111",
      state: "INIT" as const,
      expiresAt: "2030-01-02T03:34:05.000Z",
      credentialExpiresAt: "2030-01-02T03:14:05.000Z",
      upload: { url: "https://upload.example.test/object", method: "PUT" as const, headers: {} },
      userId
    };
  }
  public async reissueCredentials(userId: string, sessionId: string) {
    if (userId !== "user-1" || sessionId !== "11111111-1111-4111-8111-111111111111") throw new Error("UPLOAD_SESSION_NOT_FOUND");
    return { url: "https://upload.example.test/object-2", method: "PUT" as const, headers: {}, expiresAt: "2030-01-02T03:14:05.000Z" };
  }
  public async completeUpload(userId: string, sessionId: string) {
    if (userId !== "user-1" || sessionId !== "11111111-1111-4111-8111-111111111111") throw new Error("UPLOAD_SESSION_NOT_FOUND");
    return { sessionId, state: "UPLOADED" as const };
  }
  public async getStatus(userId: string, sessionId: string) {
    if (userId !== "user-1" || sessionId !== "11111111-1111-4111-8111-111111111111") throw new Error("UPLOAD_SESSION_NOT_FOUND");
    return { sessionId, state: "UPLOADED" as const };
  }
  public async cancel(userId: string, sessionId: string) {
    if (userId !== "user-1" || sessionId !== "11111111-1111-4111-8111-111111111111") throw new Error("UPLOAD_SESSION_NOT_FOUND");
  }
}

describe("uploads API", () => {
  it("registers upload routes in production assembly only with an explicit storage adapter", async () => {
    const pool = { end: async () => undefined } as never;
    const baseConfig = {
      nodeEnv: "test" as const, acceptanceMode: false,
      accessTokenLifetimeMilliseconds: 7_200_000, host: "127.0.0.1", port: 3100,
      mysqlUrl: "mysql://user:pass@127.0.0.1/photo_ai", wechatAppId: "wx4f7678cc595d276b",
      wechatAppSecret: "test-secret", identityLookupKey: Buffer.alloc(32, 1),
      identityEncryptionKey: Buffer.alloc(32, 2)
    };
    const withoutStorage = buildProductionApp(baseConfig, { pool });
    const withStorage = buildProductionApp(baseConfig, { pool, objectStorage: new MockObjectStorage() });
    try {
      await withoutStorage.ready();
      await withStorage.ready();
      expect(withoutStorage.hasRoute({ method: "POST", url: "/v1/uploads" })).toBe(false);
      expect(withStorage.hasRoute({ method: "POST", url: "/v1/uploads" })).toBe(true);
    } finally { await withoutStorage.close(); await withStorage.close(); }
  });

  it("creates a session and returns 202 from completion without provider work", async () => {
    const service = new MemoryUploadApiService();
    const app = buildUploadApp(service);
    try {
      const created = await app.inject({
        method: "POST", url: "/v1/uploads", headers: { authorization: "Bearer owner" },
        payload: { fileName: "photo.jpg", sizeBytes: 1024, metadataRemovalConsentVersion: "2026-08-02" }
      });
      expect(created.statusCode).toBe(201);
      const completed = await app.inject({
        method: "POST", url: "/v1/uploads/11111111-1111-4111-8111-111111111111/complete",
        headers: { authorization: "Bearer owner" }, payload: { etag: "etag-1" }
      });
      expect(completed.statusCode).toBe(202);
      expect(service.providerCalls).toBe(0);
    } finally { await app.close(); }
  });

  it("hides another user's session and rejects invalid bodies", async () => {
    const app = buildUploadApp(new MemoryUploadApiService());
    try {
      const other = await app.inject({
        method: "POST", url: "/v1/uploads/11111111-1111-4111-8111-111111111111/complete",
        headers: { authorization: "Bearer other" }, payload: { etag: "etag-1" }
      });
      expect(other.statusCode).toBe(404);
      const invalid = await app.inject({
        method: "POST", url: "/v1/uploads", headers: { authorization: "Bearer owner" }, payload: { fileName: "x.exe" }
      });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it.each(["UPLOAD_STATE_CONFLICT", "UPLOAD_ETAG_MISMATCH"])(
    "maps %s to a safe conflict response",
    async (code) => {
      const service = new MemoryUploadApiService();
      service.completeUpload = async () => { throw new Error(code); };
      const app = buildUploadApp(service);
      try {
        const response = await app.inject({
          method: "POST", url: "/v1/uploads/11111111-1111-4111-8111-111111111111/complete",
          headers: { authorization: "Bearer owner" }, payload: { etag: "etag-1" }
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ code });
      } finally { await app.close(); }
    }
  );
});
