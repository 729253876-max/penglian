import { createTask } from "../../services/api";

const input = { tool: "PORTRAIT_RETOUCH" as const, inputAssetId: "demo-portrait-001", direction: "NATURAL" as const, parameters: { brightness: 0, warmth: 0, naturalness: 80 } };

type Runtime = {
  alive: boolean;
  generation: number;
  requestId: number;
  pendingRequest: boolean;
};
const runtimes = new WeakMap<object, Runtime>();

function begin(page: object): Runtime {
  const previous = runtimes.get(page);
  if (previous) previous.alive = false;
  const runtime = {
    alive: true,
    generation: (previous?.generation ?? 0) + 1,
    requestId: 0,
    pendingRequest: false
  };
  runtimes.set(page, runtime);
  return runtime;
}

function current(page: object, runtime: Runtime, generation: number, requestId?: number): boolean {
  return runtime.alive && runtime.generation === generation && runtimes.get(page) === runtime && (requestId === undefined || runtime.requestId === requestId);
}

Page({
  data: { submitting: false, error: "" },
  onLoad() { begin(this as unknown as object); },
  onShow() {
    const runtime = runtimes.get(this as unknown as object);
    if (runtime?.alive) {
      this.setData({ submitting: runtime.pendingRequest });
    }
  },
  onUnload() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime) return;
    runtime.alive = false;
    runtime.generation += 1;
    runtimes.delete(page);
  },
  async startPreview() {
    if (this.data.submitting) return;
    const page = this as unknown as object;
    const runtime = runtimes.get(page) ?? begin(page);
    if (runtime.pendingRequest) return;
    const generation = runtime.generation;
    const requestId = runtime.requestId + 1;
    runtime.requestId = requestId;
    runtime.pendingRequest = true;
    this.setData({ submitting: true, error: "" });
    try {
      const task = await createTask(input);
      if (!current(page, runtime, generation, requestId)) return;
      runtime.pendingRequest = false;
      this.setData({ submitting: false });
      wx.navigateTo({ url: `/pages/live/index?taskId=${task.taskId}` });
    } catch {
      if (!current(page, runtime, generation, requestId)) return;
      runtime.pendingRequest = false;
      this.setData({ submitting: false, error: "暂时无法创建任务，请确认本地 API 已启动后重试。" });
    }
  }
});
