import { describe, expect, it } from "vitest";
import { UploadFinalizationService } from "../src/application/upload-finalization-service.js";
import { MockImageNormalizer } from "../src/infrastructure/mock-image-normalizer.js";

describe("upload finalization service", () => {
  it("accepts private object metadata and atomically enqueues normalization", async () => {
    const calls: unknown[] = [];
    const service = new UploadFinalizationService(
      { headPrivateObject: async () => ({ sizeBytes: 1024, contentType: "image/jpeg", etag: "etag-1" }) },
      {
        acceptUploadedObject: async (input) => { calls.push(input); },
        completeNormalization: async () => { throw new Error("unexpected"); },
        failNormalization: async () => { throw new Error("unexpected"); }
      }
    );

    await service.acceptUploadedObject({
      sessionId: "session-1",
      userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      now: new Date("2030-01-02T03:04:05.000Z")
    });

    expect(calls).toEqual([expect.objectContaining({
      sessionId: "session-1",
      expectedState: "INIT",
      nextState: "UPLOADED",
      normalizeJobIdempotencyKey: "normalize:session-1",
      source: { sizeBytes: 1024, contentType: "image/jpeg", etag: "etag-1" }
    })]);
  });

  it("writes normalized assets and moderation work in one repository operation", async () => {
    const completed: unknown[] = [];
    const service = new UploadFinalizationService(
      { headPrivateObject: async () => { throw new Error("unexpected"); } },
      {
        acceptUploadedObject: async () => { throw new Error("unexpected"); },
        completeNormalization: async (input) => { completed.push(input); },
        failNormalization: async () => { throw new Error("unexpected"); }
      },
      new MockImageNormalizer("jpeg")
    );

    await service.normalizeAcceptedUpload({
      sessionId: "session-1",
      userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      now: new Date("2030-01-02T03:04:05.000Z")
    });

    expect(completed).toEqual([expect.objectContaining({
      expectedState: "UPLOADED",
      nextState: "REVIEWING",
      moderationJobIdempotencyKey: "moderate:session-1",
      normalized: expect.objectContaining({ colorSpace: "sRGB", metadataRemoved: true }),
      audit: expect.objectContaining({ width: 4000, height: 3000 })
    })]);
  });

  it("fails closed and enqueues cleanup on a permanent decode error", async () => {
    const failed: unknown[] = [];
    const service = new UploadFinalizationService(
      { headPrivateObject: async () => { throw new Error("unexpected"); } },
      {
        acceptUploadedObject: async () => { throw new Error("unexpected"); },
        completeNormalization: async () => { throw new Error("unexpected"); },
        failNormalization: async (input) => { failed.push(input); }
      },
      new MockImageNormalizer("corrupt")
    );

    await expect(service.normalizeAcceptedUpload({
      sessionId: "session-1",
      userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      now: new Date("2030-01-02T03:04:05.000Z")
    })).rejects.toThrow("IMAGE_DECODE_FAILED");
    expect(failed).toEqual([expect.objectContaining({
      expectedState: "UPLOADED",
      nextState: "FAILED",
      errorCode: "IMAGE_DECODE_FAILED",
      cleanupJobIdempotencyKey: "cleanup:session-1"
    })]);
  });

  it("leaves transient normalizer failures retryable without changing upload state", async () => {
    let failCalls = 0;
    const service = new UploadFinalizationService(
      { headPrivateObject: async () => { throw new Error("unexpected"); } },
      {
        acceptUploadedObject: async () => { throw new Error("unexpected"); },
        completeNormalization: async () => { throw new Error("unexpected"); },
        failNormalization: async () => { failCalls += 1; }
      },
      { inspectAndNormalize: async () => { throw new Error("TENCENT_CI_TIMEOUT"); } }
    );

    await expect(service.normalizeAcceptedUpload({
      sessionId: "session-1",
      userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      now: new Date("2030-01-02T03:04:05.000Z")
    })).rejects.toThrow("TENCENT_CI_TIMEOUT");
    expect(failCalls).toBe(0);
  });
});
