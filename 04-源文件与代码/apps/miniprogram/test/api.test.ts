import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CreateTaskInput,
  EditTraceEvent,
  TaskSnapshot
} from "@photo-ai/contracts";
import {
  createTask,
  getEvents,
  getTask,
  runPreview
} from "../miniprogram/services/api";

const taskSnapshot: TaskSnapshot = {
  taskId: "task-1",
  status: "REVIEWING",
  tool: "PORTRAIT_RETOUCH",
  lastSequence: 0
};

const createInput: CreateTaskInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "asset-1",
  direction: "NATURAL",
  parameters: {
    brightness: 0,
    warmth: 0,
    naturalness: 90
  }
};

function event(eventId: string, sequence: number): EditTraceEvent {
  return {
    eventId,
    taskId: "task-1",
    sequence,
    type: "STAGE_STARTED",
    phase: "RETOUCH",
    occurredAt: "2026-07-24T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey: "portrait.stage.retouch.started",
    payload: {}
  };
}

function installAuthenticatedWx(
  request: (options: WechatMiniprogram.RequestOption) => void
) {
  vi.stubGlobal("wx", {
    getStorageSync(key: string) {
      if (key !== "photo-ai:session") return undefined;
      return {
        accessToken: "api-test-access",
        accessExpiresAt: "2030-08-02T02:00:00.000Z",
        refreshToken: "api-test-refresh",
        refreshExpiresAt: "2030-09-01T00:00:00.000Z"
      };
    },
    removeStorageSync: vi.fn(),
    reLaunch: vi.fn(),
    request
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("miniprogram API client", () => {
  it("creates a task and returns the validated snapshot", async () => {
    let sent: WechatMiniprogram.RequestOption | undefined;
    installAuthenticatedWx((options) => {
      sent = options;
      options.success?.({ statusCode: 201, data: taskSnapshot });
    });

    await expect(createTask(createInput)).resolves.toEqual(taskSnapshot);
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("http://127.0.0.1:3100/v1/tasks");
    expect(sent?.data).toEqual(createInput);
    expect(sent?.header).toEqual({ Authorization: "Bearer api-test-access" });
  });

  it("sends a JSON body when starting preview generation", async () => {
    let sent: WechatMiniprogram.RequestOption | undefined;
    installAuthenticatedWx((options) => {
      sent = options;
      options.success?.({ statusCode: 202, data: taskSnapshot });
    });

    await expect(runPreview("task-1")).resolves.toEqual(taskSnapshot);
    expect(sent?.method).toBe("POST");
    expect(sent?.data).toEqual({});
  });

  it("rejects non-success responses without exposing the response body", async () => {
    installAuthenticatedWx((options) => {
      options.success?.({
        statusCode: 503,
        data: { internalDetail: "not for the client" }
      });
    });

    await expect(getTask("task-1")).rejects.toThrow("API_503");
  });

  it("rejects malformed event pages at the response boundary", async () => {
    installAuthenticatedWx((options) => {
      options.success?.({ statusCode: 200, data: { items: [] } });
    });

    await expect(getEvents("task-1", 0)).rejects.toThrow("API_RESPONSE_INVALID");
  });

  it.each([
    ["changes an empty page cursor", 0, { items: [], nextSequence: 1 }],
    ["orders items backwards", 0, { items: [event("evt-2", 2), event("evt-1", 1)], nextSequence: 1 }],
    ["includes an item at or before the cursor", 1, { items: [event("evt-1", 1)], nextSequence: 1 }],
    ["does not match the final item cursor", 0, { items: [event("evt-2", 2)], nextSequence: 3 }],
    ["repeats a sequence", 0, { items: [event("evt-1", 1), event("evt-2", 1)], nextSequence: 1 }],
    ["jumps over a missing sequence", 0, {
      items: [event("evt-2", 2), event("evt-5", 5)],
      nextSequence: 5
    }],
    ["contains an event from a different task", 0, {
      items: [{ ...event("evt-1", 1), taskId: "task-2" }],
      nextSequence: 1
    }]
  ])("rejects event pages that %s", async (_name, afterSequence, data) => {
    installAuthenticatedWx((options) => {
      options.success?.({ statusCode: 200, data });
    });

    await expect(getEvents("task-1", afterSequence)).rejects.toThrow("API_RESPONSE_INVALID");
  });

  it.each([
    ["keeps the cursor for an empty page", 4, { items: [], nextSequence: 4 }],
    ["accepts a continuous incremental page", 0, {
      items: [event("evt-1", 1), event("evt-2", 2)],
      nextSequence: 2
    }]
  ])("accepts event pages that %s", async (_name, afterSequence, data) => {
    installAuthenticatedWx((options) => {
      options.success?.({ statusCode: 200, data });
    });

    await expect(getEvents("task-1", afterSequence)).resolves.toEqual(data);
  });

  it("rejects wx request failures with the original error", async () => {
    const networkError = new Error("network unavailable");
    installAuthenticatedWx((options) => {
      options.fail?.(networkError);
    });

    await expect(getTask("task-1")).rejects.toBe(networkError);
  });

  it("rejects invalid task snapshots at the response boundary", async () => {
    installAuthenticatedWx((options) => {
      options.success?.({
        statusCode: 200,
        data: { ...taskSnapshot, lastSequence: -1 }
      });
    });

    await expect(getTask("task-1")).rejects.toThrow("API_RESPONSE_INVALID");
  });

  it("encodes task ids before constructing request URLs", async () => {
    let sent: WechatMiniprogram.RequestOption | undefined;
    const taskId = "task /?#% 中文";
    installAuthenticatedWx((options) => {
      sent = options;
      options.success?.({ statusCode: 200, data: taskSnapshot });
    });

    await expect(getTask(taskId)).resolves.toEqual(taskSnapshot);
    expect(sent?.url).toBe(`http://127.0.0.1:3100/v1/tasks/${encodeURIComponent(taskId)}`);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY]
  ])("rejects %s event cursors before issuing a request", async (_name, afterSequence) => {
    let requestCount = 0;
    installAuthenticatedWx(() => {
      requestCount += 1;
    });

    await expect(getEvents("task-1", afterSequence)).rejects.toThrow("INVALID_AFTER_SEQUENCE");
    expect(requestCount).toBe(0);
  });

  it("settles from the first wx callback", async () => {
    const laterFailure = new Error("late failure");
    installAuthenticatedWx((options) => {
      options.success?.({ statusCode: 200, data: taskSnapshot });
      options.fail?.(laterFailure);
    });

    await expect(getTask("task-1")).resolves.toEqual(taskSnapshot);
  });
});
