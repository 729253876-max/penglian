import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateTaskInput, TaskSnapshot } from "@photo-ai/contracts";
import { createTask, getEvents, getTask } from "../miniprogram/services/api";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("miniprogram API client", () => {
  it("creates a task and returns the validated snapshot", async () => {
    let sent: WechatMiniprogram.RequestOption | undefined;
    vi.stubGlobal("wx", {
      request(options: WechatMiniprogram.RequestOption) {
        sent = options;
        options.success?.({ statusCode: 201, data: taskSnapshot });
      }
    });

    await expect(createTask(createInput)).resolves.toEqual(taskSnapshot);
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("http://127.0.0.1:3100/v1/tasks");
    expect(sent?.data).toEqual(createInput);
  });

  it("rejects non-success responses without exposing the response body", async () => {
    vi.stubGlobal("wx", {
      request(options: WechatMiniprogram.RequestOption) {
        options.success?.({
          statusCode: 503,
          data: { internalDetail: "not for the client" }
        });
      }
    });

    await expect(getTask("task-1")).rejects.toThrow("API_503");
  });

  it("rejects malformed event pages at the response boundary", async () => {
    vi.stubGlobal("wx", {
      request(options: WechatMiniprogram.RequestOption) {
        options.success?.({ statusCode: 200, data: { items: [] } });
      }
    });

    await expect(getEvents("task-1", 0)).rejects.toThrow("API_RESPONSE_INVALID");
  });

  it("rejects unsafe event cursors before issuing a request", async () => {
    let requestCount = 0;
    vi.stubGlobal("wx", {
      request() {
        requestCount += 1;
      }
    });

    await expect(getEvents("task-1", -1)).rejects.toThrow("INVALID_AFTER_SEQUENCE");
    expect(requestCount).toBe(0);
  });
});
