import type { EditTraceEvent } from "@photo-ai/contracts";
import { getEvents, runPreview } from "../../services/api";
import { mergeEvents } from "../../services/edit-trace";

type RenderEvent = EditTraceEvent & { text: string };
const copy: Record<string, string> = {
  "portrait.diagnosis.started": "正在分析照片的光线、肤质与主体结构",
  "portrait.diagnosis.light": "检测到面部暗部与背景高光差异",
  "portrait.plan.natural": "已制定保留真实肤质的自然精修方案",
  "portrait.stage.retouch.started": "正在恢复人物局部光影与肤质层次",
  "portrait.parameter.direction": "已应用适中的自然精修方向",
  "portrait.stage.retouch.completed": "人物局部调整已完成",
  "quality.started": "正在检查身份与非目标区域稳定性",
  "quality.identity.passed": "人物身份一致性检查通过",
  "preview.ready": "水印预览已生成"
};
let pending: RenderEvent[] = [];
let revealTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

Page({
  data: { taskId: "", allEvents: [] as EditTraceEvent[], visibleEvents: [] as RenderEvent[], lastSequence: 0, ready: false, error: "" },
  onLoad(options: Record<string, string | undefined>) {
    const taskId = options.taskId;
    if (!taskId) { this.setData({ error: "任务编号缺失，请返回重新创建任务。" }); return; }
    disposed = false; pending = []; revealTimer = undefined; pollTimer = undefined;
    this.setData({ taskId, allEvents: [], visibleEvents: [], lastSequence: 0, ready: false, error: "" });
    void this.start();
  },
  onUnload() { disposed = true; if (revealTimer) clearTimeout(revealTimer); if (pollTimer) clearTimeout(pollTimer); revealTimer = undefined; pollTimer = undefined; },
  async start() {
    try { await runPreview(this.data.taskId); if (!disposed) await this.poll(); }
    catch { if (!disposed) this.setData({ error: "精修任务暂时无法继续，请检查本地 API 后重试。" }); }
  },
  async poll() {
    if (disposed || this.data.ready) return;
    try {
      const response = await getEvents(this.data.taskId, this.data.lastSequence);
      if (disposed) return;
      const allEvents = mergeEvents(this.data.allEvents, response.items);
      const seen = new Set([...this.data.visibleEvents, ...pending].map((item) => item.eventId));
      pending.push(...response.items
        .filter((item) => {
          if (seen.has(item.eventId)) return false;
          seen.add(item.eventId);
          return true;
        })
        .map((item) => ({ ...item, text: copy[item.copyKey] ?? "任务已记录新的可见处理事件。" })));
      this.setData({ allEvents, lastSequence: response.nextSequence });
      this.revealNext();
      if (!response.items.some((item) => item.type === "PREVIEW_READY")) pollTimer = setTimeout(() => void this.poll(), 500);
    } catch { if (!disposed) this.setData({ error: "无法获取精修进度，请检查网络或本地 API 后重试。" }); }
  },
  revealNext() {
    if (disposed || revealTimer || pending.length === 0) return;
    const next = pending.shift();
    if (!next) return;
    revealTimer = setTimeout(() => {
      revealTimer = undefined;
      if (disposed) return;
      this.setData({ visibleEvents: [...this.data.visibleEvents, next], ready: next.type === "PREVIEW_READY" || this.data.ready });
      this.revealNext();
    }, 420);
  },
  openPreview() { wx.navigateTo({ url: `/pages/preview/index?taskId=${this.data.taskId}` }); },
  retry() { this.setData({ error: "" }); void this.poll(); }
});
