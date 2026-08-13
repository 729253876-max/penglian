import { productEvents } from "../../services/product-events";
import { getEvents, getTask } from "../../services/api";
import { presentTrace, type RenderEvent } from "../../services/edit-trace-presentation";

function continuous(events: readonly { taskId: string; sequence: number }[], taskId: string): boolean {
  return events.every((event, index) => event.taskId === taskId && event.sequence === index + 1);
}

Page({
  data: {
    comparePercent: 50,
    showDetails: false,
    taskId: "",
    canPreview: false,
    previewUrl: "",
    originalPlaceholder: "/assets/demo-before.svg",
    trace: [] as RenderEvent[]
  },
  async onLoad(options: Record<string, string | undefined>) {
    const taskId = options.taskId;
    if (!taskId) {
      wx.redirectTo({ url: "/pages/live/index" });
      return;
    }
    this.setData({ taskId });
    try {
      const [task, response] = await Promise.all([getTask(taskId), getEvents(taskId, 0)]);
      const qualityIndex = response.items.findLastIndex((event) =>
        event.type === "QUALITY_CHECK_PASSED" && event.evidenceSource === "QUALITY_GATE"
      );
      const readyIndex = response.items.findLastIndex((event) =>
        event.type === "PREVIEW_READY" && event.evidenceSource === "QUALITY_GATE"
      );
      const valid = task.status === "SUCCEEDED" && Boolean(task.previewUrl) &&
        response.nextSequence === response.items.length && continuous(response.items, taskId) &&
        qualityIndex >= 0 && readyIndex === response.items.length - 1 && qualityIndex < readyIndex;
      if (!valid) {
        wx.redirectTo({ url: `/pages/live/index?taskId=${encodeURIComponent(taskId)}` });
        return;
      }
      this.setData({ canPreview: true, previewUrl: task.previewUrl!, trace: presentTrace(response.items) });
    } catch {
      wx.redirectTo({ url: `/pages/live/index?taskId=${encodeURIComponent(taskId)}` });
    }
  },
  setComparison(event: { detail: { value: unknown } }) {
    const value = event.detail.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const comparePercent = Math.max(0, Math.min(100, value));
    this.setData({ comparePercent });
    productEvents.record("PREVIEW_COMPARE_USED", { mode: "SLIDER" });
  },
  toggleDetails() {
    const showDetails = !this.data.showDetails;
    this.setData({ showDetails });
    productEvents.record("PREVIEW_DETAILS_TOGGLED", {
      state: showDetails ? "OPEN" : "CLOSED"
    });
  },
  adjustAgain() {
    wx.redirectTo({ url: "/pages/plan/index?scenario=travel-portrait" });
  },
  viewFullTrace() {
    wx.redirectTo({ url: `/pages/live/index?taskId=${encodeURIComponent(this.data.taskId)}` });
  }
});
