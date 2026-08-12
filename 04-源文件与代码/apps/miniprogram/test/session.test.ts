import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
const staleRefreshResult: SessionPair = {
  accessToken: "access-stale-rotated-secret",
  accessExpiresAt: "2030-08-02T01:00:00.000Z",
  refreshToken: "refresh-stale-rotated-secret",
  refreshExpiresAt: "2030-08-31T00:00:00.000Z"
};
const newerRefreshResult: SessionPair = {
  accessToken: "access-third-secret",
  accessExpiresAt: "2030-08-02T01:45:00.000Z",
  refreshToken: "refresh-third-secret",
  refreshExpiresAt: "2030-08-30T00:00:00.000Z"
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

function runGenerator(
  scriptPath: string,
  command: "--local" | "--from-env",
  environment: Record<string, string> = {}
) {
  const result = spawnSync(process.execPath, [scriptPath, command], {
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
  if (result.status !== 0) {
    throw new Error(
      `runtime generator failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`
    );
  }
}

function requestUrlFromNativeSession(sessionPath: string): string {
  const sessionUrl = pathToFileURL(sessionPath).href;
  const script = `
const now = Date.now();
const pair = {
  accessToken: "native-check-access",
  accessExpiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
  refreshToken: "native-check-refresh",
  refreshExpiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString()
};
let requestedUrl;
globalThis.wx = {
  getStorageSync() {},
  setStorageSync() {},
  removeStorageSync() {},
  login(options) {
    options.success({ code: "native-wechat-code", errMsg: "login:ok" });
  },
  request(options) {
    requestedUrl = options.url;
    options.success({ statusCode: 201, data: pair });
  }
};
const { ensureSession } = await import(${JSON.stringify(sessionUrl)});
await ensureSession({ policyVersion: "2026-08-02", metadataRemoval: true });
process.stdout.write(requestedUrl ?? "");
`;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    script
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `native session failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

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
    request: vi.fn((options: WechatMiniprogram.RequestOption) => {
      requests.push({
        method: options.method,
        url: options.url,
        data: structuredClone(options.data),
        header: structuredClone(options.header as Record<string, string> | undefined)
      });
      requestHandler(options);
    }),
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
  vi.doUnmock("../miniprogram/config/runtime.generated.js");
  vi.resetModules();
  storage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ensureSession", () => {
  it("uses the generated acceptance origin for the real identity request", async () => {
    vi.resetModules();
    vi.doMock("../miniprogram/config/runtime.generated.js", () => ({
      runtimeConfig: Object.freeze({
        mode: "acceptance",
        apiBase: "http://192.168.1.20:3100"
      })
    }));
    requestHandler = (options) => respond(options, 201, firstPair);

    const acceptanceSession = await import(
      "../miniprogram/services/session.js"
    );
    await acceptanceSession.ensureSession(consent);

    expect(wx.request).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://192.168.1.20:3100/v1/identity/wechat"
    }));
  });

  it("normalizes wx request failures without retaining raw diagnostics", async () => {
    const rawFailure = {
      errMsg: "request:fail upstream-secret-message",
      errno: 600001,
      exception: { reasons: [], retryCount: 1 },
      useHttpDNS: false,
      diagnosticSecret: "upstream-secret-field"
    } as WechatMiniprogram.RequestFailCallbackErr & {
      diagnosticSecret: string;
    };
    requestHandler = (options) => options.fail?.(rawFailure);

    let rejection: unknown;
    try {
      await ensureSession(consent);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("WECHAT_NETWORK_ERROR");
    expect(rejection).not.toHaveProperty("errMsg");
    expect(rejection).not.toHaveProperty("diagnosticSecret");
    expect(String(rejection)).not.toContain("upstream-secret");
  });

  it("resets a built acceptance runtime to local before real session loads", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "photo-ai-runtime-sequence-"));
    const scriptsDirectory = join(temporaryRoot, "scripts");
    const miniprogramDirectory = join(temporaryRoot, "miniprogram");
    const configDirectory = join(miniprogramDirectory, "config");
    const servicesDirectory = join(miniprogramDirectory, "services");
    mkdirSync(scriptsDirectory, { recursive: true });
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(servicesDirectory, { recursive: true });
    const generatorPath = join(scriptsDirectory, "generate-runtime-config.cjs");
    const sessionPath = join(servicesDirectory, "session.js");
    copyFileSync(
      new URL("../scripts/generate-runtime-config.cjs", import.meta.url),
      generatorPath
    );
    copyFileSync(
      new URL("../miniprogram/services/session.js", import.meta.url),
      sessionPath
    );
    writeFileSync(
      join(miniprogramDirectory, "package.json"),
      '{"type":"module"}\n'
    );
    writeFileSync(
      join(configDirectory, "runtime.generated.js"),
      "export const runtimeConfig = Object.freeze({\n" +
        '  mode: "acceptance",\n' +
        '  apiBase: "http://192.168.1.20:3100"\n' +
        "});\n"
    );
    try {
      runGenerator(generatorPath, "--from-env", {
        PHOTO_AI_APP_MODE: "acceptance",
        PHOTO_AI_API_BASE: "http://192.168.1.20:3100"
      });
      runGenerator(generatorPath, "--local");

      expect(requestUrlFromNativeSession(sessionPath)).toBe(
        "http://127.0.0.1:3100/v1/identity/wechat"
      );
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

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

  it("keeps a newly logged-in pair when an older pending refresh succeeds", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    let pendingOldRefresh: WechatMiniprogram.RequestOption | undefined;
    requestHandler = (options) => {
      if (options.url?.endsWith("/v1/sessions/refresh")) {
        pendingOldRefresh = options;
        return;
      }
      if (options.url?.endsWith("/v1/identity/wechat")) {
        return respond(options, 201, refreshedPair);
      }
      if (requests.filter((request) => request.url?.includes("/v1/tasks/")).length === 1) {
        return respond(options, 401, {});
      }
      return respond(options, 200, { taskId: "task-1" });
    };

    const oldRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    );
    await Promise.resolve();
    if (!pendingOldRefresh) throw new Error("old refresh was not captured");

    await ensureSession(consent);
    respond(pendingOldRefresh, 200, staleRefreshResult);

    await expect(oldRequest).resolves.toEqual({ taskId: "task-1" });
    expect(storage.get(sessionKey)).toEqual(refreshedPair);
    expect(requests.at(-1)?.header).toEqual({
      Authorization: "Bearer access-second-secret"
    });
  });

  it("uses a newer stored pair for the single retry when an old refresh fails", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    let pendingOldRefresh: WechatMiniprogram.RequestOption | undefined;
    let taskCalls = 0;
    requestHandler = (options) => {
      if (options.url?.endsWith("/v1/sessions/refresh")) {
        pendingOldRefresh = options;
        return;
      }
      taskCalls += 1;
      return respond(options, taskCalls === 1 ? 401 : 200, { taskId: "task-1" });
    };

    const oldRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-1" },
      (value) => value
    );
    await Promise.resolve();
    if (!pendingOldRefresh) throw new Error("old refresh was not captured");

    storage.set(sessionKey, refreshedPair);
    respond(pendingOldRefresh, 401, {});

    await expect(oldRequest).resolves.toEqual({ taskId: "task-1" });
    expect(storage.get(sessionKey)).toEqual(refreshedPair);
    expect(requests.at(-1)?.header).toEqual({
      Authorization: "Bearer access-second-secret"
    });
    expect(taskCalls).toBe(2);
  });

  it("runs independent single flights for different refresh tokens", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    const pendingRefreshes = new Map<string, WechatMiniprogram.RequestOption>();
    const refreshCounts = new Map<string, number>();
    requestHandler = (options) => {
      if (options.url?.endsWith("/v1/sessions/refresh")) {
        const token = (options.data as { refreshToken: string }).refreshToken;
        refreshCounts.set(token, (refreshCounts.get(token) ?? 0) + 1);
        pendingRefreshes.set(token, options);
        return;
      }
      const authorization = (options.header as Record<string, string>).Authorization;
      if (authorization === "Bearer access-first-secret") {
        return respond(options, 401, {});
      }
      if (
        options.url?.endsWith("/v1/tasks/task-new") &&
        authorization === "Bearer access-second-secret"
      ) {
        return respond(options, 401, {});
      }
      return respond(options, 200, { authorization });
    };

    const oldRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-old" },
      (value) => value
    );
    await Promise.resolve();
    storage.set(sessionKey, refreshedPair);
    const newRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-new" },
      (value) => value
    );
    await Promise.resolve();

    const oldRefresh = pendingRefreshes.get("refresh-first-secret");
    const newRefresh = pendingRefreshes.get("refresh-second-secret");
    if (!oldRefresh) throw new Error("old refresh must be captured");
    respond(oldRefresh, 200, staleRefreshResult);
    if (newRefresh) respond(newRefresh, 200, newerRefreshResult);

    const results = await Promise.all([oldRequest, newRequest]);

    expect([...refreshCounts.entries()]).toEqual([
      ["refresh-first-secret", 1],
      ["refresh-second-secret", 1]
    ]);
    expect(results).toEqual([
      { authorization: "Bearer access-second-secret" },
      { authorization: "Bearer access-third-secret" }
    ]);
    expect(storage.get(sessionKey)).toEqual(newerRefreshResult);
  });

  it("old flight cleanup does not remove a different pair flight still in progress", async () => {
    storage.set(sessionKey, firstPair);
    storage.set(deviceKey, "device-stable-one");
    const pendingRefreshes = new Map<string, WechatMiniprogram.RequestOption>();
    const refreshCounts = new Map<string, number>();
    requestHandler = (options) => {
      if (options.url?.endsWith("/v1/sessions/refresh")) {
        const token = (options.data as { refreshToken: string }).refreshToken;
        refreshCounts.set(token, (refreshCounts.get(token) ?? 0) + 1);
        pendingRefreshes.set(token, options);
        return;
      }
      return respond(options, 401, {});
    };

    const oldRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-old" },
      (value) => value
    );
    await Promise.resolve();
    storage.set(sessionKey, refreshedPair);
    const firstNewRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-new-1" },
      (value) => value
    );
    await Promise.resolve();

    const oldRefresh = pendingRefreshes.get("refresh-first-secret");
    if (oldRefresh) respond(oldRefresh, 200, staleRefreshResult);
    await Promise.resolve();

    const secondNewRequest = authenticatedRequest(
      { method: "GET", url: "/v1/tasks/task-new-2" },
      (value) => value
    );
    await Promise.resolve();

    for (const [token, pending] of pendingRefreshes) {
      if (token !== "refresh-first-secret") {
        respond(pending, 200, newerRefreshResult);
      }
    }
    await Promise.allSettled([oldRequest, firstNewRequest, secondNewRequest]);
    expect(refreshCounts.get("refresh-second-secret")).toBe(1);
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

  it("returns only an explicitly allowed safe business error code", async () => {
    storage.set(sessionKey, firstPair);
    requestHandler = (options) => respond(options, 409, { code: "UPLOAD_ETAG_MISMATCH" });

    await expect(authenticatedRequest(
      { method: "POST", url: "/v1/uploads/session-1/complete" },
      (value) => value,
      ["UPLOAD_ETAG_MISMATCH"]
    )).rejects.toThrow("UPLOAD_ETAG_MISMATCH");

    requestHandler = (options) => respond(options, 409, { code: "INTERNAL_DATABASE_DETAIL" });
    await expect(authenticatedRequest(
      { method: "POST", url: "/v1/uploads/session-1/complete" },
      (value) => value,
      ["UPLOAD_ETAG_MISMATCH"]
    )).rejects.toThrow("API_409");
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
