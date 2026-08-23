import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelUpload,
  clearUploadResume,
  completeUpload,
  createUploadSession,
  getUploadStatus,
  pollUploadStatus,
  presentUploadStatus,
  readUploadResume,
  reissueUploadCredential,
  uploadSelectedPhoto,
  uploadFailureMessage,
  validateLocalFile,
  wechatPutTransport,
  writeUploadResume
} from "../miniprogram/services/upload";

const sessionId = "11111111-1111-4111-8111-111111111111";
const approvedAssetId = "22222222-2222-4222-8222-222222222222";
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
    }, expect.any(Function), ["CONSENT_REQUIRED", "IMAGE_TOO_LARGE", "IMAGE_FORMAT_UNSUPPORTED"]);
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

describe("presigned PUT transport", () => {
  it("uploads file bytes with the exact signed target and returns a normalized ETag", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    Object.assign(wx, {
      getFileSystemManager: vi.fn(() => ({
        readFile: ({ success }: { success: (result: { data: ArrayBuffer }) => void }) => success({ data: bytes })
      })),
      request: vi.fn((options: WechatMiniprogram.RequestOption) => {
        options.success?.({
          statusCode: 200,
          data: "",
          header: { ETag: '  "etag-1"  ' },
          cookies: [],
          profile: {} as WechatMiniprogram.RequestProfile,
          errMsg: "request:ok"
        });
        return {} as WechatMiniprogram.RequestTask;
      })
    });

    await expect(wechatPutTransport.putFile({
      filePath: "/tmp/photo.jpg",
      target: {
        url: "https://upload.example.test/object",
        method: "PUT",
        headers: { "x-cos-acl": "private" },
        expiresAt: "2030-01-02T03:14:05.000Z"
      }
    })).resolves.toEqual({ etag: "etag-1" });
    expect(wx.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: "https://upload.example.test/object",
      data: bytes,
      header: { "x-cos-acl": "private" }
    }));
  });

  it("rejects a successful PUT without an ETag", async () => {
    Object.assign(wx, {
      getFileSystemManager: vi.fn(() => ({
        readFile: ({ success }: { success: (result: { data: ArrayBuffer }) => void }) => success({ data: new ArrayBuffer(1) })
      })),
      request: vi.fn((options: WechatMiniprogram.RequestOption) => {
        options.success?.({ statusCode: 200, data: "", header: {}, cookies: [], profile: {} as WechatMiniprogram.RequestProfile, errMsg: "request:ok" });
        return {} as WechatMiniprogram.RequestTask;
      })
    });

    await expect(wechatPutTransport.putFile({
      filePath: "/tmp/photo.jpg",
      target: { url: "https://upload.example.test/object", method: "PUT", headers: {}, expiresAt: "2030-01-02T03:14:05.000Z" }
    })).rejects.toThrow("UPLOAD_ETAG_MISSING");
  });
});

describe("bounded upload credential recovery", () => {
  const photo = { path: "/tmp/photo.jpg", name: "photo.jpg", size: 1024 };
  const initial = {
    sessionId,
    state: "INIT" as const,
    expiresAt: "2030-01-02T03:34:05.000Z",
    credentialExpiresAt: "2030-01-02T03:14:05.000Z",
    upload: { url: "https://upload.example.test/object", method: "PUT" as const, headers: {} }
  };

  it("reissues once after an expired credential returns 403, then completes and queries status", async () => {
    const events: string[] = [];
    let puts = 0;
    const status = await uploadSelectedPhoto(photo, {
      now: () => new Date("2030-01-02T03:14:06.000Z"),
      createSession: async () => { events.push("create"); return initial; },
      reissue: async () => { events.push("reissue"); return { url: "https://upload.example.test/object-2", method: "PUT", headers: {}, expiresAt: "2030-01-02T03:24:06.000Z" }; },
      transport: { putFile: async () => { puts += 1; events.push(`put-${puts}`); if (puts === 1) throw new Error("UPLOAD_HTTP_403"); return { etag: "etag-1" }; } },
      complete: async (_id, etag) => { events.push(`complete:${etag}`); return { sessionId, state: "UPLOADED" }; },
      getStatus: async () => { events.push("status"); return { sessionId, state: "REVIEWING" }; },
      persistResume: (value) => { events.push(`persist:${value.state}`); }
    });

    expect(status).toEqual({ sessionId, state: "REVIEWING" });
    expect(events).toEqual(["create", "put-1", "reissue", "put-2", "complete:etag-1", "status", "persist:PROCESSING"]);
  });

  it("also reissues once when an expired credential returns 401", async () => {
    let puts = 0;
    let reissues = 0;
    await expect(uploadSelectedPhoto(photo, {
      now: () => new Date("2030-01-02T03:14:06.000Z"),
      createSession: async () => initial,
      reissue: async () => { reissues += 1; return { url: "https://upload.example.test/object-2", method: "PUT", headers: {}, expiresAt: "2030-01-02T03:24:06.000Z" }; },
      transport: { putFile: async () => { puts += 1; if (puts === 1) throw new Error("UPLOAD_HTTP_401"); return { etag: "etag-1" }; } },
      complete: async () => ({ sessionId, state: "UPLOADED" }),
      getStatus: async () => ({ sessionId, state: "UPLOADED" }),
      persistResume: () => {}
    })).resolves.toEqual({ sessionId, state: "UPLOADED" });
    expect(puts).toBe(2);
    expect(reissues).toBe(1);
  });

  it("rejects an invalid local file before creating a server session", async () => {
    let creates = 0;
    await expect(uploadSelectedPhoto({ path: "/tmp/photo.gif", name: "photo.gif", size: 1024 }, {
      now: () => new Date(now),
      createSession: async () => { creates += 1; return initial; },
      reissue: async () => { throw new Error("unexpected"); },
      transport: { putFile: async () => { throw new Error("unexpected"); } },
      complete: async () => ({ sessionId, state: "UPLOADED" }),
      getStatus: async () => ({ sessionId, state: "UPLOADED" }),
      persistResume: () => {}
    })).rejects.toThrow("IMAGE_FORMAT_UNSUPPORTED");
    expect(creates).toBe(0);
  });

  it.each([
    ["403 before expiry", "2030-01-02T03:14:04.000Z", "UPLOAD_HTTP_403"],
    ["network failure after expiry", "2030-01-02T03:14:06.000Z", "UPLOAD_NETWORK_ERROR"]
  ])("does not reissue for %s", async (_name, clock, failureCode) => {
    let reissues = 0;
    await expect(uploadSelectedPhoto(photo, {
      now: () => new Date(clock),
      createSession: async () => initial,
      reissue: async () => { reissues += 1; throw new Error("unexpected"); },
      transport: { putFile: async () => { throw new Error(failureCode); } },
      complete: async () => ({ sessionId, state: "UPLOADED" }),
      getStatus: async () => ({ sessionId, state: "UPLOADED" }),
      persistResume: () => {}
    })).rejects.toThrow(failureCode);
    expect(reissues).toBe(0);
  });

  it("stops after the reissued credential also returns 403", async () => {
    let puts = 0;
    let reissues = 0;
    await expect(uploadSelectedPhoto(photo, {
      now: () => new Date("2030-01-02T03:14:06.000Z"),
      createSession: async () => initial,
      reissue: async () => { reissues += 1; return { url: "https://upload.example.test/object-2", method: "PUT", headers: {}, expiresAt: "2030-01-02T03:24:06.000Z" }; },
      transport: { putFile: async () => { puts += 1; throw new Error("UPLOAD_HTTP_403"); } },
      complete: async () => ({ sessionId, state: "UPLOADED" }),
      getStatus: async () => ({ sessionId, state: "UPLOADED" }),
      persistResume: () => {}
    })).rejects.toThrow("UPLOAD_HTTP_403");
    expect(puts).toBe(2);
    expect(reissues).toBe(1);
  });
});

describe("safe upload presentation", () => {
  it("keeps only a valid approved asset id in a continuable presentation", () => {
    expect(presentUploadStatus({
      sessionId,
      state: "APPROVED",
      assetId: approvedAssetId
    })).toMatchObject({
      phase: "READY",
      assetId: approvedAssetId,
      canContinue: true
    });

    expect(presentUploadStatus({
      sessionId,
      state: "APPROVED",
      assetId: "invalid-asset-id"
    } as never)).not.toHaveProperty("assetId");
    expect(presentUploadStatus({
      sessionId,
      state: "APPROVED",
      assetId: "invalid-asset-id"
    } as never).canContinue).toBe(false);
  });

  it("never leaks an asset id from a non-approved status", () => {
    expect(presentUploadStatus({
      sessionId,
      state: "REVIEWING",
      assetId: approvedAssetId
    } as never)).not.toHaveProperty("assetId");
  });

  it.each([
    [{ sessionId, state: "UPLOADED" as const }, "PROCESSING", false],
    [{ sessionId, state: "NORMALIZING" as const }, "PROCESSING", false],
    [{ sessionId, state: "REVIEWING" as const }, "RECHECKING", false],
    [{ sessionId, state: "APPROVED" as const, assetId: approvedAssetId, qualityWarning: false }, "READY", true],
    [{ sessionId, state: "APPROVED" as const, assetId: approvedAssetId, qualityWarning: true }, "WARNING", true],
    [{ sessionId, state: "REJECTED" as const }, "FAILED", false],
    [{ sessionId, state: "FAILED" as const, failureCode: "IMAGE_SHORT_EDGE_TOO_SMALL" }, "FAILED", false],
    [{ sessionId, state: "EXPIRED" as const }, "FAILED", false],
    [{ sessionId, state: "CANCELED" as const }, "FAILED", false]
  ])("maps %# to %s", (status, phase, canContinue) => {
    const result = presentUploadStatus(status);
    expect(result.phase).toBe(phase);
    expect(result.canContinue).toBe(canContinue);
    if (phase === "FAILED") {
      expect(result.detail).toContain("本次未扣除免费次数或积分");
      expect(result.detail).not.toMatch(/COS|CI|腾讯|confidence|objectKey/i);
    }
  });

  it("uses approved safe copy and never interpolates unknown errors", () => {
    expect(uploadFailureMessage(new Error("IMAGE_TOO_LARGE")))
      .toBe("这张照片超过 30 MB，请选择更小的原图。本次未扣除免费次数或积分。");
    expect(uploadFailureMessage(new Error("SecretKey=raw-secret COS confidence=0.99")))
      .toBe("上传暂时没有完成，请检查网络后重试。本次未扣除免费次数或积分。");
  });
});

describe("bounded upload polling", () => {
  it("queries immediately, waits only for processing states, and returns a terminal presentation", async () => {
    const events: string[] = [];
    const states = ["UPLOADED", "NORMALIZING", "APPROVED"] as const;
    const result = await pollUploadStatus(sessionId, {
      signal: new AbortController().signal,
      wait: async (milliseconds) => { events.push(`wait:${milliseconds}`); },
      maxPolls: 3,
      getStatus: async () => {
        const state = states.shift() ?? "APPROVED";
        return state === "APPROVED" ? { sessionId, state, assetId: approvedAssetId } : { sessionId, state };
      }
    });

    expect(result.phase).toBe("READY");
    expect(events).toEqual(["wait:2000", "wait:2000"]);
  });

  it("stops after maxPolls and preserves a processing result", async () => {
    let queries = 0;
    const result = await pollUploadStatus(sessionId, {
      signal: new AbortController().signal,
      wait: async () => {},
      maxPolls: 2,
      getStatus: async () => { queries += 1; return { sessionId, state: "REVIEWING" }; }
    });

    expect(queries).toBe(2);
    expect(result.phase).toBe("RECHECKING");
    expect(result.canContinue).toBe(false);
  });

  it("does not query again after the wait aborts", async () => {
    const controller = new AbortController();
    let queries = 0;
    await expect(pollUploadStatus(sessionId, {
      signal: controller.signal,
      wait: async () => { controller.abort(); },
      maxPolls: 3,
      getStatus: async () => { queries += 1; return { sessionId, state: "UPLOADED" }; }
    })).rejects.toThrow("UPLOAD_POLL_ABORTED");
    expect(queries).toBe(1);
  });
});
