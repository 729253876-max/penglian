import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";

type PageConfig = Record<string, any> & { data?: Record<string, unknown> };

const api = {
  createTask: vi.fn(),
  getEvents: vi.fn(),
  runPreview: vi.fn()
};

vi.mock("../miniprogram/services/api", () => api);

function event(eventId: string, sequence: number, type: EditTraceEvent["type"] = "STAGE_STARTED"): EditTraceEvent {
  return {
    eventId,
    taskId: "task-1",
    sequence,
    type,
    phase: type === "PREVIEW_READY" ? "PREVIEW" : "RETOUCH",
    occurredAt: "2026-07-24T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey: type === "PREVIEW_READY" ? "preview.ready" : "portrait.stage.retouch.started",
    payload: {}
  };
}

function pageInstance(config: PageConfig) {
  const page = Object.assign({
    data: structuredClone(config.data ?? {}),
    setData(patch: Record<string, unknown>) {
      Object.assign(this.data, patch);
    }
  }, config);
  page.data = structuredClone(config.data ?? {});
  return page;
}

async function loadPage(path: string): Promise<PageConfig> {
  let config: PageConfig | undefined;
  vi.stubGlobal("Page", (definition: PageConfig) => { config = definition; });
  vi.stubGlobal("wx", { navigateTo: vi.fn(), redirectTo: vi.fn() });
  await import(path);
  if (!config) throw new Error("page was not registered");
  return config;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("plan page", () => {
  it("prevents a second visible submission while the first task is pending", async () => {
    const deferred = Promise.withResolvers<{ taskId: string }>();
    api.createTask.mockReturnValueOnce(deferred.promise);
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);

    const first = config.startPreview.call(page);
    const second = config.startPreview.call(page);
    expect(page.data.submitting).toBe(true);
    expect(api.createTask).toHaveBeenCalledTimes(1);

    deferred.resolve({ taskId: "task-1" });
    await Promise.all([first, second]);
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/live/index?taskId=task-1" });
  });

  it("restores the primary action after task creation fails", async () => {
    api.createTask.mockRejectedValueOnce(new Error("offline"));
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);

    await config.startPreview.call(page);
    expect(page.data.submitting).toBe(false);
    expect(page.data.error).toContain("本地 API");
  });
  it("does not navigate or change a disposed submission when its request resolves", async () => {
    const deferred = Promise.withResolvers<{ taskId: string }>();
    api.createTask.mockReturnValueOnce(deferred.promise).mockResolvedValueOnce({ taskId: "task-b" });
    const config = await loadPage("../miniprogram/pages/plan/index");
    const first = pageInstance(config);
    const second = pageInstance(config);

    config.onLoad.call(first);
    const pending = config.startPreview.call(first);
    config.onUnload.call(first);
    config.onLoad.call(second);
    await config.startPreview.call(second);
    deferred.resolve({ taskId: "task-a" });
    await pending;

    expect(wx.navigateTo).toHaveBeenCalledTimes(1);
    expect(wx.navigateTo).toHaveBeenLastCalledWith({ url: "/pages/live/index?taskId=task-b" });
    expect(second.data.error).toBe("");
  });

  it("does not show a failure from a disposed submission", async () => {
    const deferred = Promise.withResolvers<{ taskId: string }>();
    api.createTask.mockReturnValueOnce(deferred.promise);
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);

    config.onLoad.call(page);
    const pending = config.startPreview.call(page);
    config.onUnload.call(page);
    deferred.reject(new Error("offline"));
    await pending;

    expect(page.data.error).toBe("");
  });
});

describe("live page", () => {
  it("shows an actionable error instead of starting a task without taskId", async () => {
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, {});
    expect(page.data.error).toContain("任务编号缺失");
    expect(api.runPreview).not.toHaveBeenCalled();
  });

  it("reveals deduplicated server events and becomes ready only after the real preview event", async () => {
    vi.useFakeTimers();
    api.runPreview.mockResolvedValueOnce({ taskId: "task-1" });
    api.getEvents.mockResolvedValueOnce({ items: [event("one", 1), event("one", 1), event("ready", 2, "PREVIEW_READY")], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await vi.runAllTimersAsync();
    expect(page.data.visibleEvents).toHaveLength(2);
    expect(page.data.ready).toBe(true);
    expect(page.data.lastSequence).toBe(2);
  });

  it("clears timers and never reveals an event after unload", async () => {
    vi.useFakeTimers();
    api.runPreview.mockResolvedValueOnce({ taskId: "task-1" });
    api.getEvents.mockResolvedValueOnce({ items: [event("one", 1)], nextSequence: 1 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    config.onUnload.call(page);
    await vi.runAllTimersAsync();
    expect(page.data.visibleEvents).toEqual([]);
  });
  it("keeps each page runtime isolated when an unloaded page resolves after a new load", async () => {
    vi.useFakeTimers();
    const firstPreview = Promise.withResolvers<{ taskId: string }>();
    api.runPreview.mockReturnValueOnce(firstPreview.promise).mockResolvedValueOnce({ taskId: "task-b" });
    api.getEvents.mockResolvedValueOnce({ items: [event("b-ready", 1, "PREVIEW_READY")], nextSequence: 1 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const first = pageInstance(config);
    const second = pageInstance(config);

    config.onLoad.call(first, { taskId: "task-a" });
    config.onUnload.call(first);
    config.onLoad.call(second, { taskId: "task-b" });
    await Promise.resolve();
    await Promise.resolve();
    firstPreview.resolve({ taskId: "task-a" });
    await vi.runAllTimersAsync();

    expect(api.getEvents).toHaveBeenCalledTimes(1);
    expect(first.data.visibleEvents).toEqual([]);
    expect(second.data.visibleEvents).toHaveLength(1);
    expect(second.data.ready).toBe(true);
  });

  it("does not overlap a retry with its scheduled poll", async () => {
    vi.useFakeTimers();
    const retryRequest = Promise.withResolvers<{ items: EditTraceEvent[]; nextSequence: number }>();
    api.runPreview.mockResolvedValueOnce({ taskId: "task-1" });
    api.getEvents.mockResolvedValueOnce({ items: [], nextSequence: 0 }).mockReturnValueOnce(retryRequest.promise);
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    config.retry.call(page);
    await vi.advanceTimersByTimeAsync(500);

    expect(api.getEvents).toHaveBeenCalledTimes(2);
    retryRequest.resolve({ items: [event("ready", 1, "PREVIEW_READY")], nextSequence: 1 });
    await vi.runAllTimersAsync();
    expect(page.data.ready).toBe(true);
  });
});

describe("preview page", () => {
  it("switches the visible comparison and returns to adjustment", async () => {
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    config.showBefore.call(page);
    expect(page.data.showAfter).toBe(false);
    config.showAfter.call(page);
    expect(page.data.showAfter).toBe(true);
    config.adjustAgain.call(page);
    expect(wx.redirectTo).toHaveBeenCalledWith({ url: "/pages/plan/index" });
  });
});
