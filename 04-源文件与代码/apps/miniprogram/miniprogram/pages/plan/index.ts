import { createTask } from "../../services/api";

const input = { tool: "PORTRAIT_RETOUCH" as const, inputAssetId: "demo-portrait-001", direction: "NATURAL" as const, parameters: { brightness: 0, warmth: 0, naturalness: 80 } };

Page({
  data: { submitting: false, error: "" },
  onShow() { this.setData({ submitting: false }); },
  async startPreview() {
    if (this.data.submitting) return;
    this.setData({ submitting: true, error: "" });
    try {
      const task = await createTask(input);
      wx.navigateTo({ url: `/pages/live/index?taskId=${task.taskId}` });
    } catch {
      this.setData({ submitting: false, error: "暂时无法创建任务，请确认本地 API 已启动后重试。" });
    }
  }
});
