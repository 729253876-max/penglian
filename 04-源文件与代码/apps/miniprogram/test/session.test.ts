import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentInput, SessionPair } from "@photo-ai/contracts";
import {
  authenticatedRequest,
  ensureSession
} from "../miniprogram/services/session";

const sessionKey = "photo-ai:session";
const deviceKey = "photo-ai:device-id";
const consent: ConsentInput = {
  policyVersion: "2026-08-02",
  metadataRemoval: true
};
const firstPair: SessionPair = {
  accessToken: "access-first-secret",
  accessExpiresAt: "2030-08-02T02:00:00.000Z",
  refreshToken: "refresh-first-secret",
  refreshExpiresAt: "2030-09-01T00:00:00.000Z"
};
const refreshedPair: SessionPair = {
  accessToken: "access-second-secret",
  accessExpiresAt: "2030-08-02T01:30:00.000Z",
  refreshToken: "refresh-second-secret",
  refreshExpiresAt: "2030-09-01T00:00:00.000Z"
};

type RequestRecord = {
  method?: string;
  url?: string;
  data?: unknown;
  header?: Record<string, string>;
};

const storage = new Map<string, unknown>();
let requests: RequestRecord[];
let loginCount: number;
let requestHandler: (options: WechatMiniprogram.RequestOption) => void;

function installWx() {
  vi.stubGlobal("wx", {
    getStorageSync(key: string) {
      return storage.get(key);
    },
    setStorageSync(key: string, value: unknown) {
      storage.set(key, structuredClone(value));
    },
    removeStorageSync(key: string) {
      storage.delete(key);
    },
    login(options: WechatMiniprogram.LoginOption) {
      loginCount += 1;
      options.success?.({ code: "wechat-one-time-code", errMsg: "login:ok" });
    },
    request(options: WechatMiniprogram.RequestOption) {
      requests.push({
        method: options.method,
        url: options.url,
        data: structuredClone(options.data),
        header: structuredClone(options.header as Record<string, string> | undefined)
      });
      requestHandler(options);
    },
    reLaunch: vi.fn()
  });
}

function respond(
  options: WechatMiniprogram.RequestOption,
  statusCode: number,
  data: unknown
) {
  options.success?.({ statusCode, data });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-08-02T00:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.25);
  storage.clear();
  requests = [];
  loginCount = 0;
  requestHandler = () => {
    throw new Error("unexpected request");
  };
  installWx();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ensureSession", () => {
  it("records fresh consent even when a strictly valid session is already stored", async () => {
    storage.set(sessionKey, firstPair);
    requestHandler = (options) => respond(options, 201, refreshedPair);

    await expect(ensureSession(consent)).resolves.toEqual(refreshedPair);
    expect(loginCount).toBe(1);
    expect(requests).toEqual([expect.objectContaining({
      method: "POST",
      url: "http://127.0.0.1:3100/v1/identity/wechat",
      data: expect.objectContaining({ consent })
    })]);
    expect(storage.get(sessionKey)).toEqual(refreshedPair);
  });

  it("logs in when the stored access token is expired and stores the validated pair", async () => {
    storage.set(sessionKey, {
      ...firstPair,
      accessExpiresAt: "2030-08-01T23:59:59.000Z"
    });
    requestHandler = (options) => respond(options, 201, firstPair);

    await expect(ensureSession(consent)).resolves.toEqual(firstPair);

    expect(loginCount).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:3100/v1/identity/wechat",
      data: {
        code: "wechat-one-time-code",
        deviceId: expect.stringMatching(/^device-/),
        consent
      }
    });
    expect(storage.get(sessionKey)).toEqual(firstPair);
  });

  it("persists one anonymous device id and reuses it across later logins", async () => {
    requestHandler = (options) => respond(options, 201, firstPair);
    await ensureSession(consent);
    const firstDeviceId = storage.get(deviceKey);
    storage.delete(sessionKey);
    requestHandler = (options) => respond(options, 201, refreshedPair);

    await ensureSession(consent);

    expect(firstDeviceId).toMatch(/^device-/);
    expect(storage.get(deviceKey)).toBe(firstDeviceId);
    expect(requests.map((request) => (
      request.data as { deviceId: string }
    ).deviceId)).toEqual([firstDeviceId, firstDeviceId]);
  });

  it.each([
    ["uses an unapproved policy", { policyVersion: "privacy-v1", metadataRemoval: true }],
    ["declines metadata removal", { policyVersion: "2026-08-02", metadataRemoval: false }],
    ["omits the metadata choice", { policyVersion: "2026-08-02" }],
    ["adds an undeclared field", { policyVersion: "2026-08-02", metadataRemoval: true, tracking: true }],
    ["uses a non-boolean metadata choice", { policyVersion: "2026-08-02", metadataRemoval: "yes" }]
  ])("rejects consent that %s before login or storage", async (_name, invalid) => {
    await expect(ensureSession(invalid as ConsentInput)).rejects.toThrow("CONSENT_INVALID");
    expect(loginCount).toBe(0);
    expect(requests).toEqual([]);
    expect(storage.has(sessionKey)).toBe(false);
  });

  it.each([
    ["misses a token", { ...firstPair, refreshToken: undefined }],
    ["contains an empty token", { ...firstPair, accessToken: "" }],
    ["contains an invalid expiry", { ...firstPair, accessExpiresAt: "tomorrow" }],
    ["contains an overflow ISO date", { ...firstPair, accessExpiresAt: "2030-02-30T00:30:00.000Z" }],
    ["grants a four-hour access token", { ...firstPair, accessExpiresAt: "2030-08-02T04:00:00.000Z" }],
    ["grants refresh beyond thirty days", { ...firstPair, refreshExpiresAt: "2030-09-01T00:00:00.001Z" }],
    ["expires access after refresh", {
      ...firstPair,
      accessExpiresAt: "2030-08-02T01:00:00.000Z",
      refreshExpiresAt: "2030-08-02T00:30:00.000Z"
    }],
    ["contains an extra field", { ...firstPair, userId: "not-local-session-data" }]
  ])("does not store a login response that %s", async (_name, invalidPair) => {
    requestHandler = (options) => respond(options, 201, invalidPair);

    await expect(ensureSession(consent)).rejects.toThrow("API_RESPONSE_INVALID");

    expect(storage.has(sessionKey)).toBe(false);
  });
});

describe("authenticatedRequest", () => {
  it("adds the stored access token as a Bearer header", async () => {
    storage.set(sessionKey, firstPair);
    requestHandler = (options) => respond(options, 200, { ok: true });

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).resolves.toEqual({ ok: true });

    expect(requests).toEqual([expect.objectContaining({
      url: "http://127.0.0.1:3100/v1/tasks/task-1",
      header: { Authorization: "Bearer access-first-secret" }
    })]);
  });

  it("does not silently log in or call the protected API without a local session", async () => {
    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("SESSION_REQUIRED");

    expect(loginCount).toBe(0);
    expect(requests).toEqual([]);
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/privacy/index" });
  });

  it("refreshes once after the first 401, stores the new pair, and retries once", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    requestHandler = (options) => {
      if (requests.length === 1) return respond(options, 401, { code: "UNAUTHORIZED" });
      if (requests.length === 2) return respond(options, 200, refreshedPair);
      return respond(options, 200, { taskId: "task-1" });
    };

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).resolves.toEqual({ taskId: "task-1" });

    expect(requests).toEqual([
      expect.objectContaining({
        url: "http://127.0.0.1:3100/v1/tasks/task-1",
        header: { Authorization: "Bearer access-first-secret" }
      }),
      expect.objectContaining({
        method: "POST",
        url: "http://127.0.0.1:3100/v1/sessions/refresh",
        data: {
          refreshToken: "refresh-first-secret",
          deviceId: "device-stable-one"
        }
      }),
      expect.objectContaining({
        url: "http://127.0.0.1:3100/v1/tasks/task-1",
        header: { Authorization: "Bearer access-second-secret" }
      })
    ]);
    expect(storage.get(sessionKey)).toEqual(refreshedPair);
  });

  it("proactively refreshes locally expired access before calling the protected API", async () => {
    storage.set(sessionKey, {
      ...firstPair,
      accessExpiresAt: "2030-08-01T23:59:59.000Z"
    });
    storage.set(deviceKey, "device-stable-one");
    requestHandler = (options) => {
      if (requests.length === 1) return respond(options, 200, refreshedPair);
      return respond(options, 200, { taskId: "task-1" });
    };

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).resolves.toEqual({ taskId: "task-1" });

    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3100/v1/sessions/refresh",
      "http://127.0.0.1:3100/v1/tasks/task-1"
    ]);
  });

  it("clears a locally expired refresh session without calling the protected API", async () => {
    storage.set(sessionKey, {
      ...firstPair,
      accessExpiresAt: "2030-08-01T22:00:00.000Z",
      refreshExpiresAt: "2030-08-01T23:59:59.000Z"
    });

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("SESSION_REQUIRED");

    expect(requests).toEqual([]);
    expect(storage.has(sessionKey)).toBe(false);
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/privacy/index" });
  });

  it("single-flights refresh for two concurrent 401 responses", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    let taskCalls = 0;
    let refreshCalls = 0;
    let pendingRefresh: WechatMiniprogram.RequestOption | undefined;
    requestHandler = (options) => {
      if (options.url?.endsWith("/v1/sessions/refresh")) {
        refreshCalls += 1;
        pendingRefresh = options;
        return;
      }
      taskCalls += 1;
      return respond(options, taskCalls <= 2 ? 401 : 200, { taskId: `task-${taskCalls}` });
    };

    const requestsInFlight = Promise.all([
      authenticatedRequest({ method: "GET", url: "/v1/tasks/task-1" }, (value) => value),
      authenticatedRequest({ method: "GET", url: "/v1/tasks/task-2" }, (value) => value)
    ]);
    await Promise.resolve();

    expect(refreshCalls).toBe(1);
    if (!pendingRefresh) throw new Error("refresh request was not captured");
    respond(pendingRefresh, 200, refreshedPair);
    const results = await requestsInFlight;

    expect(results).toEqual([{ taskId: "task-3" }, { taskId: "task-4" }]);
    expect(requests.slice(-2).map((request) => request.header)).toEqual([
      { Authorization: "Bearer access-second-secret" },
      { Authorization: "Bearer access-second-secret" }
    ]);
  });

  it("rereads storage after 401 and retries with a newer pair without refreshing", async () => {
    storage.set(sessionKey, firstPair);
    requestHandler = (options) => {
      if (requests.length === 1) {
        storage.set(sessionKey, refreshedPair);
        return respond(options, 401, {});
      }
      return respond(options, 200, { taskId: "task-1" });
    };

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).resolves.toEqual({ taskId: "task-1" });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.header)).toEqual([
      { Authorization: "Bearer access-first-secret" },
      { Authorization: "Bearer access-second-secret" }
    ]);
    expect(requests.some((request) => request.url?.endsWith("/v1/sessions/refresh"))).toBe(false);
  });

  it("does not clear a newer stored pair when an old refresh fails late", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    requestHandler = (options) => {
      if (options.url?.endsWith("/v1/tasks/task-1")) return respond(options, 401, {});
      storage.set(sessionKey, refreshedPair);
      return respond(options, 401, {});
    };

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("SESSION_EXPIRED");

    expect(storage.get(sessionKey)).toEqual(refreshedPair);
  });

  it.each([
    ["the refresh endpoint rejects the token", 401, { code: "UNAUTHORIZED" }],
    ["the refresh response is malformed", 200, { ...refreshedPair, refreshToken: "" }]
  ])("clears the session and returns to privacy when %s", async (_name, refreshStatus, refreshData) => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    requestHandler = (options) => {
      if (requests.length === 1) return respond(options, 401, { code: "UNAUTHORIZED" });
      return respond(options, refreshStatus, refreshData);
    };

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("SESSION_EXPIRED");

    expect(requests).toHaveLength(2);
    expect(storage.has(sessionKey)).toBe(false);
    expect(wx.reLaunch).toHaveBeenCalledWith({ url: "/pages/privacy/index" });
  });

  it("clears the session when the single retried request is still unauthorized", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    requestHandler = (options) => {
      if (requests.length === 2) return respond(options, 200, refreshedPair);
      return respond(options, 401, { code: "UNAUTHORIZED" });
    };

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("SESSION_EXPIRED");

    expect(requests).toHaveLength(3);
    expect(storage.has(sessionKey)).toBe(false);
    expect(wx.reLaunch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a non-401 response", async () => {
    storage.set(sessionKey, firstPair);
    requestHandler = (options) => respond(options, 503, { internal: "hidden" });

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("API_503");

    expect(requests).toHaveLength(1);
    expect(storage.get(sessionKey)).toEqual(firstPair);
    expect(wx.reLaunch).not.toHaveBeenCalled();
  });

  it("never logs raw access or refresh tokens during authentication failures", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => logs.push(values.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...values) => logs.push(values.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...values) => logs.push(values.join(" ")));
    requestHandler = (options) => respond(options, 401, { code: "UNAUTHORIZED" });

    await expect(authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    )).rejects.toThrow("SESSION_EXPIRED");

    expect(logs.join(" ")).not.toContain(firstPair.accessToken);
    expect(logs.join(" ")).not.toContain(firstPair.refreshToken);
  });
});
