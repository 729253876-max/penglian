import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";

type PageConfig = Record<string, any> & { data?: Record<string, unknown> };

const api = {
  createTask: vi.fn(),
  getEvents: vi.fn(),
  getTask: vi.fn(),
  runPreview: vi.fn()
};
const productEvents = {
  record: vi.fn()
};
const storage = new Map<string, unknown>();
const reduceMotionStorageKey = "photo-ai:reduce-motion";
const approvedAssetId = "22222222-2222-4222-8222-222222222222";

vi.mock("../miniprogram/services/api", () => api);
vi.mock("../miniprogram/services/product-events", () => ({ productEvents }));

function event(eventId: string, sequence: number, type: EditTraceEvent["type"] = "STAGE_STARTED"): EditTraceEvent {
  const failed = type === "TASK_FAILED";
  const ready = type === "PREVIEW_READY";
  return {
    eventId,
    taskId: "task-1",
    sequence,
    type,
    phase: failed || ready ? "DELIVERY" : "RETOUCH",
    occurredAt: "2026-07-24T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey: failed
      ? "preview.provider.failed"
      : ready
        ? "preview.ready"
        : "portrait.stage.retouch.started",
    payload: failed
      ? { code: "PREVIEW_PROVIDER_FAILED" }
      : ready
        ? { watermarked: true, downloadable: false }
        : {}
  };
}

function qualityPassed(eventId: string, sequence: number): EditTraceEvent {
  return {
    ...event(eventId, sequence),
    type: "QUALITY_CHECK_PASSED",
    phase: "QUALITY",
    evidenceSource: "QUALITY_GATE",
    copyKey: "quality.fidelity.passed",
    payload: { checks: ["IDENTITY"] }
  } as EditTraceEvent;
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
  vi.stubGlobal("wx", {
    getStorageSync: vi.fn((key: string) => storage.get(key)),
    navigateBack: vi.fn(),
    navigateTo: vi.fn(),
    redirectTo: vi.fn(),
    setStorageSync: vi.fn((key: string, value: unknown) => {
      storage.set(key, value);
    })
  });
  await import(path);
  if (!config) throw new Error("page was not registered");
  return config;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  storage.clear();
});

describe("plan page", () => {
  it.each([approvedAssetId, encodeURIComponent(approvedAssetId)])(
    "accepts raw and encoded UUID assets and defaults to the natural rescue plan",
    async (assetId) => {
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { assetId });

    expect(page.data.assetId).toBe(approvedAssetId);
    expect(page.data.selectedDirection).toBe("NATURAL_RESCUE");
    expect(page.data.plans.map((plan: { direction: string; naturalness: number; detailLevel: number }) => ({
      direction: plan.direction,
      naturalness: plan.naturalness,
      detailLevel: plan.detailLevel
    }))).toEqual([
      { direction: "NATURAL_RESCUE", naturalness: 85, detailLevel: 35 },
      { direction: "CLEAR_RESCUE", naturalness: 75, detailLevel: 60 }
    ]);
    expect(page.data.plans[0].protections).toHaveLength(7);
    expect(page.data.plans[1].protections).toEqual(page.data.plans[0].protections);
    expect(page.data.plans[0].forbiddenOperations).toHaveLength(5);
    expect(page.data.plans[1].forbiddenOperations).toEqual(page.data.plans[0].forbiddenOperations);
    expect(page.data.plans[1].warning).toContain("噪点");
    }
  );

  it("rejects missing and malformed asset ids without creating a task", async () => {
    const config = await loadPage("../miniprogram/pages/plan/index");
    for (const options of [
      {},
      { assetId: "demo-portrait-001" },
      { assetId: [approvedAssetId] },
      { assetId: "%" },
      { assetId: "%E0%A4%A" }
    ]) {
      const page = pageInstance(config);
      expect(() => config.onLoad.call(page, options)).not.toThrow();
      await config.startPreview.call(page);
      expect(page.data.assetId).toBe("");
      expect(page.data.error).toBe("照片资产缺失，请重新完成私密上传。");
      expect(page.data.errorHint).toBe("请返回上传页，重新完成照片安全检查。");
    }
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it("accepts only whitelisted dataset directions and submits fixed selected parameters", async () => {
    api.createTask.mockResolvedValue({ taskId: "task-1" });
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);
    config.onLoad.call(page, { assetId: approvedAssetId });

    config.selectDirection.call(page, { currentTarget: { dataset: { direction: "CLEAR_RESCUE" } } });
    config.selectDirection.call(page, { currentTarget: { dataset: { direction: "CLEAR_RESCUE&inputAssetId=attacker" } } });
    expect(page.data.selectedDirection).toBe("CLEAR_RESCUE");

    await config.startPreview.call(page);
    expect(api.createTask).toHaveBeenCalledWith({
      tool: "PORTRAIT_RETOUCH",
      inputAssetId: approvedAssetId,
      direction: "CLEAR_RESCUE",
      parameters: { naturalness: 75, detailLevel: 60 }
    });
  });

  it("prevents a second visible submission while the first task is pending", async () => {
    const deferred = Promise.withResolvers<{ taskId: string }>();
    api.createTask.mockReturnValueOnce(deferred.promise);
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);
    config.onLoad.call(page, { assetId: approvedAssetId });

    const first = config.startPreview.call(page);
    const second = config.startPreview.call(page);
    expect(page.data.submitting).toBe(true);
    expect(api.createTask).toHaveBeenCalledTimes(1);

    deferred.resolve({ taskId: "task-1" });
    await Promise.all([first, second]);
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/live/index?taskId=task-1" });
  });

  it("keeps a pending submission locked across hide and show", async () => {
    const deferred = Promise.withResolvers<{ taskId: string }>();
    api.createTask.mockReturnValueOnce(deferred.promise);
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { assetId: approvedAssetId });
    const first = config.startPreview.call(page);
    config.onShow.call(page);
    const second = config.startPreview.call(page);

    expect(page.data.submitting).toBe(true);
    expect(api.createTask).toHaveBeenCalledTimes(1);

    deferred.resolve({ taskId: "task-1" });
    await Promise.all([first, second]);
    expect(wx.navigateTo).toHaveBeenCalledTimes(1);
  });

  it("restores the primary action after task creation fails", async () => {
    api.createTask.mockRejectedValueOnce(new Error("offline"));
    const config = await loadPage("../miniprogram/pages/plan/index");
    const page = pageInstance(config);
    config.onLoad.call(page, { assetId: approvedAssetId });

    await config.startPreview.call(page);
    expect(page.data.submitting).toBe(false);
    expect(page.data.error).toContain("本地 API");
    expect(page.data.errorHint).toBe("检查本地 API 后，再次点击“开始生成水印预览”。");
  });

  it("renders API troubleshooting only for task creation failures", async () => {
    const template = await readFile(
      new URL("../miniprogram/pages/plan/index.wxml", import.meta.url),
      "utf8"
    );

    expect(template).toContain('<view wx:if="{{errorHint}}" class="error-hint">{{errorHint}}</view>');
    expect(template).not.toContain('<view class="error-hint">检查本地 API');
  });
  it("does not navigate or change a disposed submission when its request resolves", async () => {
    const deferred = Promise.withResolvers<{ taskId: string }>();
    api.createTask.mockReturnValueOnce(deferred.promise).mockResolvedValueOnce({ taskId: "task-b" });
    const config = await loadPage("../miniprogram/pages/plan/index");
    const first = pageInstance(config);
    const second = pageInstance(config);

    config.onLoad.call(first, { assetId: approvedAssetId });
    const pending = config.startPreview.call(first);
    config.onUnload.call(first);
    config.onLoad.call(second, { assetId: approvedAssetId });
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

    config.onLoad.call(page, { assetId: approvedAssetId });
    const pending = config.startPreview.call(page);
    config.onUnload.call(page);
    deferred.reject(new Error("offline"));
    await pending;

    expect(page.data.error).toBe("");
  });
});

describe("upload page", () => {
  it("navigates with only an encoded valid approved asset id", async () => {
    const config = await loadPage("../miniprogram/pages/upload/index");
    const page = pageInstance(config);

    page.setData({ canContinue: true, assetId: approvedAssetId });
    config.continueEditing.call(page);
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: `/pages/plan/index?assetId=${encodeURIComponent(approvedAssetId)}`
    });

    vi.mocked(wx.navigateTo).mockClear();
    page.setData({ canContinue: true, assetId: `${approvedAssetId}&scenario=attacker` });
    config.continueEditing.call(page);
    expect(wx.navigateTo).not.toHaveBeenCalled();
  });
});

describe("home page", () => {
  it("routes an own-photo action through privacy without requesting a photo on load", async () => {
    const config = await loadPage("../miniprogram/pages/home/index");

    expect(config.startOwnPhoto).toBeTypeOf("function");
    expect(wx.navigateTo).not.toHaveBeenCalled();
    config.startOwnPhoto();

    expect(productEvents.record).toHaveBeenCalledWith("HOME_OWN_PHOTO_TAPPED", {
      source: "HOME"
    });
    expect(wx.navigateTo).toHaveBeenCalledWith({
      url: "/pages/privacy/index?next=upload"
    });
  });

  it("registers the private upload page", async () => {
    const manifest = JSON.parse(await readFile(
      new URL("../miniprogram/app.json", import.meta.url),
      "utf8"
    )) as { pages: string[] };

    expect(manifest.pages).toContain("pages/upload/index");
  });

  it("locks the first-screen rescue promise in the rendered template", async () => {
    const template = await readFile(
      new URL("../miniprogram/pages/home/index.wxml", import.meta.url),
      "utf8"
    );

    expect(template).toContain(
      '<view class="title" role="heading" aria-level="1">这张重要照片，还能救得更好。</view>'
    );
    expect(template).toContain(
      '<view class="subtitle">尽量保留本人、姿势和构图，先看预览，满意再解锁。</view>'
    );
  });

  it("routes the primary rescue action and demo evidence separately", async () => {
    const config = await loadPage("../miniprogram/pages/home/index");
    config.startPortraitDemo();
    expect(productEvents.record).toHaveBeenLastCalledWith("HOME_PRIMARY_TAPPED", {
      scenario: "TRAVEL_PORTRAIT"
    });
    expect(wx.navigateTo).toHaveBeenLastCalledWith({ url: "/pages/plan/index?scenario=travel-portrait" });
    config.openDemoCase();
    expect(productEvents.record).toHaveBeenLastCalledWith("DEMO_CASE_OPENED", {
      source: "HOME"
    });
    expect(wx.navigateTo).toHaveBeenLastCalledWith({ url: "/pages/cases/index" });
  });
});

describe("cases page", () => {
  it("labels the comparison as a demo and enters the same portrait flow", async () => {
    const config = await loadPage("../miniprogram/pages/cases/index");

    expect(config.data?.evidenceLabel).toBe("示例流程 / 非真实用户案例");
    config.startDemo();
    expect(productEvents.record).toHaveBeenCalledWith("DEMO_STARTED", {
      source: "CASE_PAGE"
    });
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: "/pages/plan/index?scenario=travel-portrait" });
  });
});

describe("live page", () => {
  it("keeps the full real-event stream wired to the live folding control", async () => {
    const template = await readFile(
      new URL("../miniprogram/pages/live/index.wxml", import.meta.url),
      "utf8"
    );

    expect(template).toContain('bindtap="toggleAllEvents"');
    expect(template).toContain('wx:if="{{showAllEvents}}"');
    expect(template).toContain('wx:for="{{visibleEvents}}"');
    expect(template).toContain("{{latestEvent.evidenceLabel}}");
    expect(template).toContain("{{item.evidenceLabel}}");
    expect(template).toContain('wx:for="{{failedChecks}}"');
    expect(template).toContain("{{noChargeNote}}");
  });

  it("keeps detailed real events collapsed until the user expands them", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "SUCCEEDED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 2,
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
    });
    api.getEvents.mockResolvedValueOnce({
      items: [qualityPassed("quality", 1), { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }],
      nextSequence: 2
    });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.showAllEvents).toBe(false);
    expect(page.data.latestEvent).toMatchObject({
      eventId: "ready",
      type: "PREVIEW_READY"
    });
    expect(page.data.traceSummary.map((item: { phase: string }) => item.phase)).toEqual([
      "QUALITY",
      "DELIVERY"
    ]);

    config.toggleAllEvents.call(page);
    expect(page.data.showAllEvents).toBe(true);
    expect(page.data.visibleEvents).toHaveLength(2);
  });

  it("shows an actionable error instead of starting a task without taskId", async () => {
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, {});
    expect(page.data.error).toContain("任务编号缺失");
    expect(api.runPreview).not.toHaveBeenCalled();
  });

  it("reveals deduplicated server events and becomes ready only after the real preview event", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });
    api.runPreview.mockResolvedValueOnce({
      taskId: "task-1",
      status: "SUCCEEDED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 2,
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
    });
    api.getEvents.mockResolvedValueOnce({ items: [qualityPassed("quality", 1), { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await vi.runAllTimersAsync();
    expect(page.data.visibleEvents).toHaveLength(2);
    expect(page.data.ready).toBe(true);
    expect(page.data.lastSequence).toBe(2);
  });

  it("restores the saved reduced-motion preference and reveals a batch without delay", async () => {
    vi.useFakeTimers();
    storage.set(reduceMotionStorageKey, true);
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 0
    });
    api.runPreview.mockResolvedValueOnce({
      taskId: "task-1",
      status: "PROCESSING",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 2
    });
    api.getTask.mockResolvedValueOnce({ taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2, previewUrl: "https://example.invalid/p.jpg" });
    api.getEvents.mockResolvedValueOnce({
      items: [
        qualityPassed("quality", 1),
        { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }
      ],
      nextSequence: 2
    });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.reduceMotion).toBe(true);
    expect(page.data.visibleEvents).toHaveLength(2);
    expect(page.data.ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes pending events and persists when reduced motion is enabled", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 0
    });
    api.runPreview.mockResolvedValueOnce({
      taskId: "task-1",
      status: "PROCESSING",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 2
    });
    api.getTask.mockResolvedValueOnce({ taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2, previewUrl: "https://example.invalid/p.jpg" });
    api.getEvents.mockResolvedValueOnce({
      items: [
        qualityPassed("quality", 1),
        { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }
      ],
      nextSequence: 2
    });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.data.visibleEvents).toHaveLength(2);

    config.toggleReduceMotion.call(page, { detail: { value: true } });

    expect(page.data.visibleEvents).toHaveLength(2);
    expect(page.data.ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(wx.setStorageSync).toHaveBeenCalledWith(
      reduceMotionStorageKey,
      true
    );
  });

  it("restores a succeeded task immediately without running the preview again", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "SUCCEEDED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 2,
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
    });
    api.getEvents.mockResolvedValueOnce({
      items: [
        qualityPassed("quality", 1),
        { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }
      ],
      nextSequence: 2
    });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.getTask).toHaveBeenCalledWith("task-1");
    expect(api.runPreview).not.toHaveBeenCalled();
    expect(page.data.visibleEvents).toHaveLength(2);
    expect(page.data.ready).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops permanently on a provider failure and exposes stable recovery actions", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });
    api.runPreview.mockResolvedValueOnce({
      taskId: "task-1",
      status: "FAILED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 4,
      failureCode: "PREVIEW_PROVIDER_FAILED"
    });
    api.getEvents.mockResolvedValue({
      items: [
        event("one", 1),
        event("two", 2),
        event("three", 3),
        event("failed", 4, "TASK_FAILED")
      ],
      nextSequence: 4
    });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.data.failed).toBe(true);
    expect(page.data.failureCode).toBe("PREVIEW_PROVIDER_FAILED");
    expect(page.data.visibleEvents.at(-1)).toMatchObject({
      type: "TASK_FAILED",
      text: expect.stringContaining("失败")
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.getEvents).toHaveBeenCalledTimes(1);

    config.restart.call(page);
    expect(wx.redirectTo).toHaveBeenCalledWith({
      url: "/pages/plan/index"
    });
    config.goBack.call(page);
    expect(wx.navigateBack).toHaveBeenCalledWith({ delta: 1 });
  });

  it("restores a failed task without polling or attempting another preview", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "FAILED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 4,
      failureCode: "PREVIEW_PROVIDER_FAILED"
    });
    api.getEvents.mockResolvedValueOnce({
      items: [
        event("one", 1),
        event("two", 2),
        event("three", 3),
        event("failed", 4, "TASK_FAILED")
      ],
      nextSequence: 4
    });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.runPreview).not.toHaveBeenCalled();
    expect(api.getEvents).toHaveBeenCalledTimes(1);
    expect(page.data.failed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears timers and never reveals an event after unload", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });
    api.runPreview.mockResolvedValueOnce({
      taskId: "task-1",
      status: "PROCESSING",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });
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
    api.getTask
      .mockResolvedValueOnce({
        taskId: "task-a",
        status: "AWAITING_CONFIRMATION",
        tool: "PORTRAIT_RETOUCH",
        lastSequence: 3
      })
      .mockResolvedValueOnce({
        taskId: "task-b",
        status: "AWAITING_CONFIRMATION",
        tool: "PORTRAIT_RETOUCH",
        lastSequence: 3
      })
      .mockResolvedValueOnce({ taskId: "task-b", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2, previewUrl: "https://example.invalid/p.jpg" });
    api.runPreview.mockReturnValueOnce(firstPreview.promise).mockResolvedValueOnce({ taskId: "task-b" });
    api.getEvents.mockResolvedValueOnce({ items: [{ ...qualityPassed("b-quality", 1), taskId: "task-b" }, { ...event("b-ready", 2, "PREVIEW_READY"), taskId: "task-b", evidenceSource: "QUALITY_GATE" }], nextSequence: 2 });
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
    expect(second.data.visibleEvents).toHaveLength(2);
    expect(second.data.ready).toBe(true);
  });

  it("does not overlap a retry with its scheduled poll", async () => {
    vi.useFakeTimers();
    const retryRequest = Promise.withResolvers<{ items: EditTraceEvent[]; nextSequence: number }>();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1",
      status: "AWAITING_CONFIRMATION",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });
    api.runPreview.mockResolvedValueOnce({
      taskId: "task-1",
      status: "PROCESSING",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 3
    });
    api.getEvents.mockResolvedValueOnce({ items: [], nextSequence: 0 }).mockReturnValueOnce(retryRequest.promise);
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve();
    await Promise.resolve();
    config.retry.call(page);
    await vi.advanceTimersByTimeAsync(500);

    expect(api.getEvents).toHaveBeenCalledTimes(2);
    api.getTask.mockResolvedValueOnce({ taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2, previewUrl: "https://example.invalid/p.jpg" });
    retryRequest.resolve({ items: [qualityPassed("quality", 1), { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }], nextSequence: 2 });
    await vi.runAllTimersAsync();
    expect(page.data.ready).toBe(true);
  });

  it("full-refetches once when the strict API parser rejects an incremental page", async () => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({ taskId: "task-1", status: "PROCESSING", tool: "PORTRAIT_RETOUCH", lastSequence: 0 });
    api.getEvents.mockRejectedValueOnce(new Error("API_RESPONSE_INVALID")).mockResolvedValueOnce({ items: [], nextSequence: 0 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);
    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(api.getEvents.mock.calls.map((call) => call[1])).toEqual([0, 0]);
    config.onUnload.call(page);
  });

  it("does not become ready from preview-ready while the refreshed snapshot is still processing", async () => {
    api.getTask
      .mockResolvedValueOnce({ taskId: "task-1", status: "PROCESSING", tool: "PORTRAIT_RETOUCH", lastSequence: 0 })
      .mockResolvedValueOnce({ taskId: "task-1", status: "PROCESSING", tool: "PORTRAIT_RETOUCH", lastSequence: 2 });
    api.getEvents.mockResolvedValueOnce({ items: [qualityPassed("q", 1), { ...event("r", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);
    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(page.data.ready).toBe(false);
    expect(page.data.error).toBeTruthy();
  });

  it("encodes the task id when opening preview", async () => {
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);
    page.data.taskId = "task /?#% 中文";
    config.openPreview.call(page);
    expect(wx.navigateTo).toHaveBeenCalledWith({ url: `/pages/preview/index?taskId=${encodeURIComponent(page.data.taskId)}` });
  });

  it("does not restore ready when a succeeded snapshot lacks project quality evidence", async () => {
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2,
      previewUrl: "https://example.invalid/watermarked.jpg"
    });
    api.getEvents.mockResolvedValueOnce({ items: [
      event("one", 1), event("ready", 2, "PREVIEW_READY")
    ], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(page.data.ready).toBe(false);
    expect(page.data.error).toBe("修复记录暂时不完整，请稍后返回重试。");
  });

  it.each([
    ["gap", [event("seven", 7)]],
    ["duplicate sequence", [event("one-a", 1), event("one-b", 1)]],
    ["out of order", [event("two", 2), event("one", 1)]],
    ["task mismatch", [{ ...event("one", 1), taskId: "task-other" }]]
  ])("full-refetches once then stops on a persistent %s without becoming ready", async (_name, malformed) => {
    vi.useFakeTimers();
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1", status: "PROCESSING", tool: "PORTRAIT_RETOUCH", lastSequence: 0
    });
    api.getEvents
      .mockResolvedValueOnce({ items: malformed, nextSequence: malformed.at(-1)!.sequence })
      .mockResolvedValueOnce({ items: malformed, nextSequence: malformed.at(-1)!.sequence });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await vi.runAllTimersAsync();

    expect(api.getEvents.mock.calls.map((call) => call[1])).toEqual([0, 0]);
    expect(page.data.ready).toBe(false);
    expect(page.data.error).toBe("修复记录暂时不完整，请稍后返回重试。");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows actual fidelity failures and no-charge outcome from the terminal snapshot", async () => {
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1", status: "FAILED", tool: "PORTRAIT_RETOUCH", lastSequence: 2,
      failureCode: "FIDELITY_GATE_FAILED", noCharge: true
    });
    api.getEvents.mockResolvedValueOnce({ items: [
      { ...event("quality-failed", 1), type: "QUALITY_CHECK_FAILED", phase: "QUALITY", evidenceSource: "QUALITY_GATE", copyKey: "quality.fidelity.failed", payload: { checks: ["IDENTITY", "ARTIFACTS"], failedChecks: ["IDENTITY", "ARTIFACTS"] } },
      { ...event("failed", 2, "TASK_FAILED"), evidenceSource: "QUALITY_GATE", payload: { code: "FIDELITY_GATE_FAILED" } }
    ], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/live/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(page.data.failureMessage).toBe("无法在保持本人特征的前提下完成。");
    expect(page.data.failedChecks).toEqual(["人物身份", "伪影与生成细节"]);
    expect(page.data.noChargeNote).toBe("本次未生成可查看预览，不扣免费次数或积分。");
  });
});

describe("preview page", () => {
  it("shows a real preview only for a continuous succeeded quality-gated task", async () => {
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2,
      previewUrl: "https://example.invalid/watermarked.jpg"
    });
    api.getEvents.mockResolvedValueOnce({ items: [
      { ...event("quality", 1), type: "QUALITY_CHECK_PASSED", phase: "QUALITY", evidenceSource: "QUALITY_GATE", copyKey: "quality.fidelity.passed", payload: { checks: ["IDENTITY"] } },
      { ...event("ready", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }
    ], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(page.data.canPreview).toBe(true);
    expect(page.data.previewUrl).toBe("https://example.invalid/watermarked.jpg");
    expect(page.data.originalPlaceholder).toBe("/assets/demo-before.svg");
    expect(page.data.trace).toHaveLength(2);
  });

  it("returns to live when quality evidence is incomplete", async () => {
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2,
      previewUrl: "https://example.invalid/watermarked.jpg"
    });
    api.getEvents.mockResolvedValueOnce({ items: [event("ready", 2, "PREVIEW_READY")], nextSequence: 2 });
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(page.data.canPreview).toBe(false);
    expect(wx.redirectTo).toHaveBeenCalledWith({ url: "/pages/live/index?taskId=task-1" });
  });

  it.each([
    ["snapshot task mismatch", { taskId: "other", lastSequence: 2 }, [qualityPassed("q", 1), { ...event("r", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }], 2],
    ["truncated snapshot", { taskId: "task-1", lastSequence: 3 }, [qualityPassed("q", 1), { ...event("r", 2, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }], 2],
    ["failed quality after pass", { taskId: "task-1", lastSequence: 3 }, [qualityPassed("q", 1), { ...event("f", 2), type: "QUALITY_CHECK_FAILED", phase: "QUALITY", evidenceSource: "QUALITY_GATE", payload: { checks: ["IDENTITY"], failedChecks: ["IDENTITY"] } }, { ...event("r", 3, "PREVIEW_READY"), evidenceSource: "QUALITY_GATE" }], 3]
  ])("returns to live for %s", async (_name, snapshotPatch, items, nextSequence) => {
    api.getTask.mockResolvedValueOnce({
      taskId: "task-1", status: "SUCCEEDED", tool: "PORTRAIT_RETOUCH", lastSequence: 2,
      previewUrl: "https://example.invalid/p.jpg", ...snapshotPatch
    });
    api.getEvents.mockResolvedValueOnce({ items, nextSequence });
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);
    config.onLoad.call(page, { taskId: "task-1" });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(page.data.canPreview).toBe(false);
    expect(wx.redirectTo).toHaveBeenCalledWith({ url: "/pages/live/index?taskId=task-1" });
  });

  it("keeps the product-demo boundary visible with safe image accessibility copy", async () => {
    const [planTemplate, previewTemplate] = await Promise.all([
      readFile(
        new URL("../miniprogram/pages/plan/index.wxml", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../miniprogram/pages/preview/index.wxml", import.meta.url),
        "utf8"
      )
    ]);

    expect(planTemplate).toContain(
      '<view class="demo-boundary">产品示例 / 非真实用户结果</view>'
    );
    expect(planTemplate).toContain(
      'aria-label="产品示例原图，非真实用户照片或分析结果"'
    );
    expect(previewTemplate).toContain(
      '<view class="demo-boundary">产品示例 / 非真实用户结果</view>'
    );
    expect(previewTemplate).toContain(
      'aria-label="产品示例精修效果，非真实用户结果，不代表供应商质量"'
    );
    expect(previewTemplate).toContain(
      'aria-label="产品示例原图，非真实用户照片"'
    );
    expect(previewTemplate).toContain('src="{{previewUrl}}"');
    expect(previewTemplate).toContain('src="{{originalPlaceholder}}"');
    expect(previewTemplate).toContain('bindtap="viewFullTrace"');
    expect(previewTemplate).toContain('wx:for="{{trace}}"');
  });

  it("clamps comparison movement and keeps details collapsed by default", async () => {
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    expect(page.data.comparePercent).toBe(50);
    expect(page.data.showDetails).toBe(false);
    config.setComparison.call(page, { detail: { value: 140 } });
    expect(page.data.comparePercent).toBe(100);
    expect(productEvents.record).toHaveBeenLastCalledWith("PREVIEW_COMPARE_USED", {
      mode: "SLIDER"
    });
    config.setComparison.call(page, { detail: { value: -20 } });
    expect(page.data.comparePercent).toBe(0);
    config.toggleDetails.call(page);
    expect(page.data.showDetails).toBe(true);
    expect(productEvents.record).toHaveBeenLastCalledWith("PREVIEW_DETAILS_TOGGLED", {
      state: "OPEN"
    });
    config.toggleDetails.call(page);
    expect(productEvents.record).toHaveBeenLastCalledWith("PREVIEW_DETAILS_TOGGLED", {
      state: "CLOSED"
    });
  });

  it("accepts only finite number slider values and keeps the last valid comparison otherwise", async () => {
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    config.setComparison.call(page, { detail: { value: 37 } });
    for (const value of [
      undefined,
      null,
      "",
      "37",
      "x",
      false,
      [],
      [37],
      Number.NaN,
      Number.POSITIVE_INFINITY
    ]) {
      config.setComparison.call(page, { detail: { value } });
      expect(page.data.comparePercent).toBe(37);
    }
    expect(productEvents.record).toHaveBeenCalledTimes(1);
  });

  it("accepts finite numeric slider boundaries and clamps finite overflow", async () => {
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    for (const [value, expected] of [
      [-20, 0],
      [0, 0],
      [100, 100],
      [140, 100]
    ]) {
      config.setComparison.call(page, { detail: { value } });
      expect(page.data.comparePercent).toBe(expected);
    }
    expect(productEvents.record).toHaveBeenCalledTimes(4);
  });

  it("updates the comparison while the slider is being dragged", async () => {
    const template = await readFile(
      new URL("../miniprogram/pages/preview/index.wxml", import.meta.url),
      "utf8"
    );

    expect(template).toContain('bindchanging="setComparison"');
  });

  it("returns to the portrait adjustment scenario", async () => {
    const config = await loadPage("../miniprogram/pages/preview/index");
    const page = pageInstance(config);

    config.adjustAgain.call(page);
    expect(wx.redirectTo).toHaveBeenCalledWith({
      url: "/pages/plan/index?scenario=travel-portrait"
    });
  });
});
