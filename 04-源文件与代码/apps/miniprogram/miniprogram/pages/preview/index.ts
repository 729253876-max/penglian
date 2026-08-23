import { productEvents } from "../../services/product-events";
import { getEvents, getTask } from "../../services/api";
import { presentTrace, successEvidence, type RenderEvent } from "../../services/edit-trace-presentation";

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
      if (!successEvidence(taskId, task, response.items, response.nextSequence)) {
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
