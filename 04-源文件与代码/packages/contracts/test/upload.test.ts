import { describe, expect, it } from "vitest";
import {
  CompleteUploadInputSchema,
  CreateUploadSessionInputSchema,
  ModerationOutcomeSchema,
  UploadSessionSchema,
  UploadStatusSchema
} from "../src/index.js";

describe("upload and moderation contracts", () => {
  it("accepts the inclusive 30MB HEIC boundary with current metadata consent", () => {
    expect(CreateUploadSessionInputSchema.parse({
      fileName: "family-photo.heic",
      sizeBytes: 30 * 1024 * 1024,
      metadataRemovalConsentVersion: "2026-08-02"
    })).toEqual({
      fileName: "family-photo.heic",
      sizeBytes: 30 * 1024 * 1024,
      metadataRemovalConsentVersion: "2026-08-02"
    });
  });

  it("rejects files above 30MB and stale metadata consent", () => {
    expect(CreateUploadSessionInputSchema.safeParse({
      fileName: "too-large.jpg",
      sizeBytes: 30 * 1024 * 1024 + 1,
      metadataRemovalConsentVersion: "2026-08-02"
    }).success).toBe(false);

    expect(CreateUploadSessionInputSchema.safeParse({
      fileName: "stale-consent.png",
      sizeBytes: 1024,
      metadataRemovalConsentVersion: "2025-01-01"
    }).success).toBe(false);
  });

  it("rejects unexpected privilege-bearing upload input fields", () => {
    expect(CreateUploadSessionInputSchema.safeParse({
      fileName: "photo.jpg",
      sizeBytes: 1024,
      metadataRemovalConsentVersion: "2026-08-02",
      objectKey: "users/another-user/uploads/forged/original"
    }).success).toBe(false);
  });

  it("exposes stable upload, completion, status and moderation shapes", () => {
    const session = UploadSessionSchema.parse({
      sessionId: "d9428888-122b-11e1-b85c-61cd3cbb3210",
      state: "INIT",
      expiresAt: "2026-08-12T09:30:00.000Z",
      credentialExpiresAt: "2026-08-12T09:10:00.000Z",
      upload: {
        url: "https://upload.example.test/private-object",
        method: "PUT",
        headers: { "content-type": "image/heic" }
      }
    });

    expect(session.state).toBe("INIT");
    expect(CompleteUploadInputSchema.parse({ etag: "opaque-etag" })).toEqual({
      etag: "opaque-etag"
    });
    expect(UploadStatusSchema.parse({
      sessionId: session.sessionId,
      state: "APPROVED",
      assetId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      qualityWarning: false
    }).state).toBe("APPROVED");
    expect(ModerationOutcomeSchema.parse("SUSPECTED")).toBe("SUSPECTED");
  });
});
