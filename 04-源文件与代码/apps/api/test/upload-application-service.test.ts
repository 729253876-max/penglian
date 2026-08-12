import { describe, expect, it } from "vitest";
import { UploadApplicationService } from "../src/application/upload-application-service.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const normalizedAssetId = "22222222-2222-4222-8222-222222222222";
const objectKey = `users/user-1/uploads/${sessionId}/original`;

describe("upload application service", () => {
  it("maps session creation to the public contract without owner or object key leakage", async () => {
    const service = new UploadApplicationService({
      createSession: async () => ({
        session: { id: sessionId, userId: "user-1", state: "INIT", objectKey, fileName: "photo.jpg", declaredSizeBytes: 1024, consentPolicyVersion: "2026-08-02", credentialIssueCount: 1, expiresAt: new Date("2030-01-02T03:34:05.000Z"), createdAt: new Date("2030-01-02T03:04:05.000Z"), updatedAt: new Date("2030-01-02T03:04:05.000Z") },
        credential: { url: "https://upload.example.test/object", method: "PUT", headers: {}, expiresAt: new Date("2030-01-02T03:14:05.000Z") }
      }),
      reissueCredentials: async () => { throw new Error("unexpected"); }
    }, { acceptUploadedObject: async () => { throw new Error("unexpected"); } }, {
      findOwnedStatus: async () => undefined,
      cancelOwned: async () => undefined
    });

    const result = await service.createSession("user-1", { fileName: "photo.jpg", sizeBytes: 1024, metadataRemovalConsentVersion: "2026-08-02" });
    expect(result).toEqual({
      sessionId, state: "INIT", expiresAt: "2030-01-02T03:34:05.000Z",
      credentialExpiresAt: "2030-01-02T03:14:05.000Z",
      upload: { url: "https://upload.example.test/object", method: "PUT", headers: {} }
    });
    expect(JSON.stringify(result)).not.toContain("user-1");
    expect(JSON.stringify(result)).not.toContain("objectKey");
  });

  it("completes only the server-owned object and forwards the expected etag", async () => {
    const accepted: unknown[] = [];
    const repository = {
      findOwnedStatus: async (id: string, userId: string) => id === sessionId && userId === "user-1" ? { sessionId, userId, state: "INIT" as const, objectKey, expiresAt: new Date("2030-01-02T03:34:05.000Z") } : undefined,
      cancelOwned: async () => undefined
    };
    const service = new UploadApplicationService({
      createSession: async () => { throw new Error("unexpected"); },
      reissueCredentials: async () => { throw new Error("unexpected"); }
    }, { acceptUploadedObject: async (input) => { accepted.push(input); } }, repository, { now: () => new Date("2030-01-02T03:04:05.000Z") });

    await expect(service.completeUpload("user-2", sessionId, "etag-1")).rejects.toThrow("UPLOAD_SESSION_NOT_FOUND");
    await expect(service.completeUpload("user-1", sessionId, "etag-1")).resolves.toEqual({ sessionId, state: "UPLOADED" });
    expect(accepted).toEqual([{ sessionId, userId: "user-1", sourceObjectKey: objectKey, expectedEtag: "etag-1", now: new Date("2030-01-02T03:04:05.000Z") }]);
  });

  it("reads safe status and makes cancellation idempotent", async () => {
    const canceled: unknown[] = [];
    const repository = {
      findOwnedStatus: async () => ({ sessionId, userId: "user-1", state: "FAILED" as const, objectKey, expiresAt: new Date(), qualityWarning: true, failureCode: "IMAGE_DECODE_FAILED" }),
      cancelOwned: async (...args: unknown[]) => { canceled.push(args); }
    };
    const service = new UploadApplicationService({ createSession: async () => { throw new Error("unexpected"); }, reissueCredentials: async () => { throw new Error("unexpected"); } }, { acceptUploadedObject: async () => { throw new Error("unexpected"); } }, repository, { now: () => new Date("2030-01-02T03:04:05.000Z") });

    await expect(service.getStatus("user-1", sessionId)).resolves.toEqual({ sessionId, state: "FAILED", qualityWarning: true, failureCode: "IMAGE_DECODE_FAILED" });
    await service.cancel("user-1", sessionId);
    await service.cancel("user-1", sessionId);
    expect(canceled).toHaveLength(2);
  });

  it("returns only the approved normalized asset id to its owner", async () => {
    const service = buildUploadService({
      sessionId,
      userId: "user-1",
      state: "APPROVED",
      normalizedAssetId,
      objectKey,
      expiresAt: new Date("2030-01-02T03:34:05.000Z")
    });

    await expect(service.getStatus("user-1", sessionId)).resolves.toEqual({
      sessionId,
      state: "APPROVED",
      assetId: normalizedAssetId
    });
  });

  it("does not return an asset id before approval", async () => {
    const service = buildUploadService({
      sessionId,
      userId: "user-1",
      state: "REVIEWING",
      normalizedAssetId,
      objectKey,
      expiresAt: new Date("2030-01-02T03:34:05.000Z")
    });

    await expect(service.getStatus("user-1", sessionId)).resolves.toEqual({
      sessionId,
      state: "REVIEWING"
    });
  });
});

function buildUploadService(status: {
  sessionId: string;
  userId: string;
  state: "APPROVED" | "REVIEWING";
  normalizedAssetId: string;
  objectKey: string;
  expiresAt: Date;
}) {
  return new UploadApplicationService(
    {
      createSession: async () => { throw new Error("unexpected"); },
      reissueCredentials: async () => { throw new Error("unexpected"); }
    },
    { acceptUploadedObject: async () => { throw new Error("unexpected"); } },
    {
      findOwnedStatus: async (id, userId) => id === status.sessionId && userId === status.userId
        ? status
        : undefined,
      cancelOwned: async () => undefined
    }
  );
}
