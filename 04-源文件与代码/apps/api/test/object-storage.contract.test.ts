import { describe, expect, it, vi } from "vitest";
import { MockObjectStorage } from "../src/infrastructure/mock-object-storage.js";
import {
  TencentCosObjectStorage,
  type CosClient,
  type StsCredentialIssuer
} from "../src/infrastructure/tencent-cos-object-storage.js";

const exactObjectKey = "users/user-1/uploads/session-1/original";

describe("mock object storage contract", () => {
  it("limits an upload credential to exactly one private object", async () => {
    const storage = new MockObjectStorage();
    const credential = await storage.issueUploadCredential({
      userId: "user-1",
      sessionId: "session-1",
      objectKey: exactObjectKey,
      expiresInSeconds: 600
    });

    await storage.putPrivateObject(credential, exactObjectKey, {
      sizeBytes: 123,
      contentType: "image/jpeg",
      etag: "etag-1"
    });
    await expect(storage.putPrivateObject(
      credential,
      "users/user-1/uploads/session-1/sibling",
      { sizeBytes: 123, contentType: "image/jpeg", etag: "etag-2" }
    )).rejects.toThrow("UPLOAD_CREDENTIAL_SCOPE_VIOLATION");
    await expect(storage.readPublicObject(exactObjectKey))
      .rejects.toThrow("OBJECT_NOT_PUBLIC");
  });

  it("rejects an object larger than 30MB before returning metadata", async () => {
    const storage = new MockObjectStorage();
    storage.seedPrivateObject(exactObjectKey, {
      sizeBytes: 30 * 1024 * 1024 + 1,
      contentType: "image/jpeg",
      etag: "etag-large"
    });

    await expect(storage.headPrivateObject(exactObjectKey))
      .rejects.toThrow("IMAGE_TOO_LARGE");
  });

  it("creates a bounded signed read URL and makes duplicate deletion idempotent", async () => {
    const storage = new MockObjectStorage({ nowEpochSeconds: () => 1_900_000_000 });
    storage.seedPrivateObject(exactObjectKey, {
      sizeBytes: 123,
      contentType: "image/png",
      etag: "etag-1"
    });

    const url = new URL(await storage.createReadUrl(exactObjectKey, 300));
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("expiresAt")).toBe("1900000300");
    expect(url.searchParams.get("signature")).toBeTruthy();
    await expect(storage.createReadUrl(exactObjectKey, 601))
      .rejects.toThrow("READ_URL_EXPIRY_EXCEEDED");

    await expect(storage.deleteObject(exactObjectKey)).resolves.toBeUndefined();
    await expect(storage.deleteObject(exactObjectKey)).resolves.toBeUndefined();
  });
});

describe("Tencent COS object storage adapter", () => {
  it("requests only PutObject on the exact server-owned object path", async () => {
    const getCredential = vi.fn<StsCredentialIssuer["getCredential"]>()
      .mockResolvedValue({
        startTime: 1_900_000_000,
        expiredTime: 1_900_000_600,
        credentials: {
          tmpSecretId: "temporary-id",
          tmpSecretKey: "temporary-key",
          sessionToken: "temporary-token"
        },
        requestId: "request-1"
      });
    const createUploadUrl = vi.fn<CosClient["createUploadUrl"]>()
      .mockReturnValue("https://bucket.example.test/exact?signed=1");
    const storage = new TencentCosObjectStorage({
      bucket: "private-1250000000",
      region: "ap-shanghai",
      secretId: "runtime-only-id",
      secretKey: "runtime-only-key"
    }, { getCredential }, { createUploadUrl, headObject: vi.fn(), createReadUrl: vi.fn(), deleteObject: vi.fn() });

    const credential = await storage.issueUploadCredential({
      userId: "user-1",
      sessionId: "session-1",
      objectKey: exactObjectKey,
      expiresInSeconds: 600
    });

    expect(getCredential).toHaveBeenCalledOnce();
    expect(getCredential.mock.calls[0]?.[0]).toMatchObject({
      secretId: "runtime-only-id",
      secretKey: "runtime-only-key",
      durationSeconds: 600,
      policy: {
        version: "2.0",
        statement: [{
          action: "name/cos:PutObject",
          effect: "allow",
          principal: { qcs: "*" },
          resource: "qcs::cos:ap-shanghai:uid/1250000000:prefix//1250000000/private/users/user-1/uploads/session-1/original"
        }]
      }
    });
    expect(createUploadUrl).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: exactObjectKey,
      expiresInSeconds: 600,
      temporarySecretId: "temporary-id",
      temporarySecretKey: "temporary-key",
      securityToken: "temporary-token"
    }));
    expect(credential).toEqual({
      url: "https://bucket.example.test/exact?signed=1",
      method: "PUT",
      headers: { "x-cos-acl": "private" }
    });
    expect(JSON.stringify(credential)).not.toContain("runtime-only");
    expect(JSON.stringify(credential)).not.toContain("temporary-key");
  });

  it("enforces metadata and signed-read boundaries through the COS client", async () => {
    const headObject = vi.fn<CosClient["headObject"]>().mockResolvedValue({
      sizeBytes: 30 * 1024 * 1024 + 1,
      contentType: "image/jpeg",
      etag: "etag-large"
    });
    const createReadUrl = vi.fn<CosClient["createReadUrl"]>()
      .mockReturnValue("https://bucket.example.test/read?signed=1");
    const deleteObject = vi.fn<CosClient["deleteObject"]>().mockResolvedValue(undefined);
    const storage = new TencentCosObjectStorage({
      bucket: "private-1250000000",
      region: "ap-shanghai",
      secretId: "runtime-only-id",
      secretKey: "runtime-only-key"
    }, { getCredential: vi.fn() }, {
      createUploadUrl: vi.fn(), headObject, createReadUrl, deleteObject
    });

    await expect(storage.headPrivateObject(exactObjectKey)).rejects.toThrow("IMAGE_TOO_LARGE");
    await expect(storage.createReadUrl(exactObjectKey, 601))
      .rejects.toThrow("READ_URL_EXPIRY_EXCEEDED");
    await expect(storage.createReadUrl(exactObjectKey, 300))
      .resolves.toBe("https://bucket.example.test/read?signed=1");
    expect(createReadUrl).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: exactObjectKey,
      expiresInSeconds: 300
    }));

    await expect(storage.deleteObject(exactObjectKey)).resolves.toBeUndefined();
    await expect(storage.deleteObject(exactObjectKey)).resolves.toBeUndefined();
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  it("rejects keys outside the server-owned upload namespace before COS access", async () => {
    const headObject = vi.fn<CosClient["headObject"]>();
    const createReadUrl = vi.fn<CosClient["createReadUrl"]>();
    const deleteObject = vi.fn<CosClient["deleteObject"]>();
    const storage = new TencentCosObjectStorage({
      bucket: "private-1250000000",
      region: "ap-shanghai",
      secretId: "runtime-only-id",
      secretKey: "runtime-only-key"
    }, { getCredential: vi.fn() }, {
      createUploadUrl: vi.fn(), headObject, createReadUrl, deleteObject
    });

    await expect(storage.headPrivateObject("other-user/object"))
      .rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(storage.createReadUrl("other-user/object", 300))
      .rejects.toThrow("INVALID_OBJECT_KEY");
    await expect(storage.deleteObject("other-user/object"))
      .rejects.toThrow("INVALID_OBJECT_KEY");
    expect(headObject).not.toHaveBeenCalled();
    expect(createReadUrl).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it.skip("COS_TEST_CREDENTIALS_NOT_APPROVED: real private COS contract", async () => {});
});
