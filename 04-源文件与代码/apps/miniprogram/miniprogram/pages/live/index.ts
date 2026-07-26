import type { EditTraceEvent } from "@photo-ai/contracts";
import { getEvents, runPreview } from "../../services/api";
import { mergeEvents } from "../../services/edit-trace";

type RenderEvent = EditTraceEvent & { text: string };
type Runtime = { alive: boolean; generation: number; pending: RenderEvent[]; revealTimer: ReturnType<typeof setTimeout> | undefined; pollTimer: ReturnType<typeof setTimeout> | undefined; polling: boolean };
const runtimes = new WeakMap<object, Runtime>();
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

function clearTimers(runtime: Runtime): void {
  if (runtime.revealTimer) clearTimeout(runtime.revealTimer);
  if (runtime.pollTimer) clearTimeout(runtime.pollTimer);
  runtime.revealTimer = undefined;
  runtime.pollTimer = undefined;
}

function active(page: object, runtime: Runtime, generation: number): boolean {
  return runtime.alive && runtime.generation === generation && runtimes.get(page) === runtime;
}

Page({
  data: { taskId: "", allEvents: [] as EditTraceEvent[], visibleEvents: [] as RenderEvent[], lastSequence: 0, ready: false, error: "" },
  onLoad(options: Record<string, string | undefined>) {
    const taskId = options.taskId;
    if (!taskId) { this.setData({ error: "任务编号缺失，请返回重新创建任务。" }); return; }
    const page = this as unknown as object;
    const prior = runtimes.get(page);
    if (prior) { prior.alive = false; clearTimers(prior); }
    const runtime: Runtime = { alive: true, generation: (prior?.generation ?? 0) + 1, pending: [], revealTimer: undefined, pollTimer: undefined, polling: false };
    runtimes.set(page, runtime);
    this.setData({ taskId, allEvents: [], visibleEvents: [], lastSequence: 0, ready: false, error: "" });
    void this.start();
  },
  onUnload() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime) return;
    runtime.alive = false;
    runtime.generation += 1;
    runtime.pending = [];
    clearTimers(runtime);
    runtimes.delete(page);
  },
  async start() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime) return;
    const generation = runtime.generation;
    try {
      await runPreview(this.data.taskId);
      if (!active(page, runtime, generation)) return;
      await this.poll();
    } catch {
      if (active(page, runtime, generation)) this.setData({ error: "精修任务暂时无法继续，请检查本地 API 后重试。" });
    }
  },
  async poll() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime || !runtime.alive || this.data.ready || runtime.polling) return;
    const generation = runtime.generation;
    runtime.polling = true;
    try {
      const response = await getEvents(this.data.taskId, this.data.lastSequence);
      if (!active(page, runtime, generation)) return;
      const allEvents = mergeEvents(this.data.allEvents, response.items);
      const seen = new Set([...this.data.visibleEvents, ...runtime.pending].map((item) => item.eventId));
      runtime.pending.push(...response.items.filter((item) => {
        if (seen.has(item.eventId)) return false;
        seen.add(item.eventId);
        return true;
      }).map((item) => ({ ...item, text: copy[item.copyKey] ?? "任务已记录新的可见处理事件。" })));
      this.setData({ allEvents, lastSequence: response.nextSequence });
      this.revealNext();
      if (!response.items.some((item) => item.type === "PREVIEW_READY")) {
        if (runtime.pollTimer) clearTimeout(runtime.pollTimer);
        runtime.pollTimer = setTimeout(() => {
          runtime.pollTimer = undefined;
          if (active(page, runtime, generation)) void this.poll();
        }, 500);
      }
    } catch {
      if (active(page, runtime, generation)) this.setData({ error: "无法获取精修进度，请检查网络或本地 API 后重试。" });
    } finally {
      if (active(page, runtime, generation)) runtime.polling = false;
    }
  },
  revealNext() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime || runtime.revealTimer || runtime.pending.length === 0) return;
    const generation = runtime.generation;
    const next = runtime.pending.shift();
    if (!next) return;
    runtime.revealTimer = setTimeout(() => {
      runtime.revealTimer = undefined;
      if (!active(page, runtime, generation)) return;
      this.setData({ visibleEvents: [...this.data.visibleEvents, next], ready: next.type === "PREVIEW_READY" || this.data.ready });
      this.revealNext();
    }, 420);
  },
  openPreview() { wx.navigateTo({ url: `/pages/preview/index?taskId=${this.data.taskId}` }); },
  retry() {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime || !runtime.alive) return;
    if (runtime.pollTimer) { clearTimeout(runtime.pollTimer); runtime.pollTimer = undefined; }
    this.setData({ error: "" });
    if (!runtime.polling) void this.poll();
  }
});
