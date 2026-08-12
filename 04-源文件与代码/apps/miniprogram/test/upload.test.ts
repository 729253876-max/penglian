import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelUpload,
  clearUploadResume,
  completeUpload,
  createUploadSession,
  getUploadStatus,
  readUploadResume,
  reissueUploadCredential,
  validateLocalFile,
  writeUploadResume
} from "../miniprogram/services/upload";

const sessionId = "11111111-1111-4111-8111-111111111111";
const now = "2030-01-02T03:04:05.000Z";

const session = vi.hoisted(() => ({
  authenticatedRequest: vi.fn()
}));

vi.mock("../miniprogram/services/session", () => session);

beforeEach(() => {
  const storage = new Map<string, unknown>();
  vi.stubGlobal("wx", {
    getStorageSync: vi.fn((key: string) => storage.get(key)),
    setStorageSync: vi.fn((key: string, value: unknown) => storage.set(key, structuredClone(value))),
    removeStorageSync: vi.fn((key: string) => storage.delete(key))
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("local upload validation", () => {
  it("accepts the exact 30 MB boundary", () => {
    expect(validateLocalFile({ path: "/tmp/photo.jpg", name: "photo.jpg", size: 30 * 1024 * 1024 }))
      .toEqual({ allowed: true });
  });

  it("rejects one byte over the boundary", () => {
    expect(validateLocalFile({ path: "/tmp/photo.jpg", name: "photo.jpg", size: 30 * 1024 * 1024 + 1 }))
      .toEqual({ allowed: false, code: "IMAGE_TOO_LARGE" });
  });

  it("rejects unsupported and misleading file names", () => {
    expect(validateLocalFile({ path: "/tmp/photo.gif", name: "photo.gif", size: 1024 }))
      .toEqual({ allowed: false, code: "IMAGE_FORMAT_UNSUPPORTED" });
    expect(validateLocalFile({ path: "/tmp/photo.jpg.exe", name: "photo.jpg.exe", size: 1024 }))
      .toEqual({ allowed: false, code: "IMAGE_FORMAT_UNSUPPORTED" });
  });
});

describe("upload API boundary", () => {
  it("creates a session with the approved metadata-removal policy", async () => {
    session.authenticatedRequest.mockImplementationOnce(async (request, parse) => parse({
      sessionId,
      state: "INIT",
      expiresAt: "2030-01-02T03:34:05.000Z",
      credentialExpiresAt: "2030-01-02T03:14:05.000Z",
      upload: { url: "https://upload.example.test/object", method: "PUT", headers: { "x-cos-acl": "private" } }
    }));

    await expect(createUploadSession({ path: "/tmp/photo.jpg", name: "photo.jpg", size: 1024 }))
      .resolves.toMatchObject({ sessionId, state: "INIT" });
    expect(session.authenticatedRequest).toHaveBeenCalledWith({
      method: "POST",
      url: "/v1/uploads",
      data: { fileName: "photo.jpg", sizeBytes: 1024, metadataRemovalConsentVersion: "2026-08-02" }
    }, expect.any(Function));
  });

  it("rejects malformed or extended session responses", async () => {
    session.authenticatedRequest.mockImplementationOnce(async (_request, parse) => parse({
      sessionId,
      state: "INIT",
      expiresAt: "2030-01-02T03:34:05.000Z",
      credentialExpiresAt: "2030-01-02T03:14:05.000Z",
      upload: { url: "https://upload.example.test/object", method: "PUT", headers: {} },
      objectKey: "users/user-1/uploads/session-1/original"
    }));

    await expect(createUploadSession({ path: "/tmp/photo.jpg", name: "photo.jpg", size: 1024 }))
      .rejects.toThrow("API_RESPONSE_INVALID");
  });

  it("uses encoded owned-session paths for reissue, complete, status, and cancel", async () => {
    session.authenticatedRequest
      .mockImplementationOnce(async (_request, parse) => parse({
        url: "https://upload.example.test/object-2", method: "PUT", headers: {}, expiresAt: "2030-01-02T03:14:05.000Z"
      }))
      .mockImplementationOnce(async (_request, parse) => parse({ sessionId, state: "UPLOADED" }))
      .mockImplementationOnce(async (_request, parse) => parse({ sessionId, state: "REVIEWING", qualityWarning: false }))
      .mockResolvedValueOnce(undefined);

    await reissueUploadCredential(sessionId);
    await completeUpload(sessionId, "etag-1");
    await getUploadStatus(sessionId);
    await cancelUpload(sessionId);

    expect(session.authenticatedRequest.mock.calls.map(([request]) => request)).toEqual([
      { method: "POST", url: `/v1/uploads/${sessionId}/credentials`, data: {} },
      { method: "POST", url: `/v1/uploads/${sessionId}/complete`, data: { etag: "etag-1" } },
      { method: "GET", url: `/v1/uploads/${sessionId}` },
      { method: "DELETE", url: `/v1/uploads/${sessionId}` }
    ]);
  });
});

describe("safe upload recovery", () => {
  it("stores and reads only the safe resume contract", () => {
    writeUploadResume({ sessionId, state: "UPLOADED", updatedAt: now });

    expect(readUploadResume()).toEqual({ sessionId, state: "UPLOADED", updatedAt: now });
    expect(wx.setStorageSync).toHaveBeenCalledWith("photo-ai:upload-resume:v1", {
      sessionId, state: "UPLOADED", updatedAt: now
    });
  });

  it("removes a record containing credential material or extra keys", () => {
    vi.mocked(wx.getStorageSync).mockReturnValueOnce({
      sessionId, state: "PROCESSING", updatedAt: now, url: "https://signed.example.test"
    });

    expect(readUploadResume()).toBeUndefined();
    expect(wx.removeStorageSync).toHaveBeenCalledWith("photo-ai:upload-resume:v1");
  });

  it("clears the versioned recovery key", () => {
    clearUploadResume();
    expect(wx.removeStorageSync).toHaveBeenCalledWith("photo-ai:upload-resume:v1");
  });
});
