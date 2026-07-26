import type {
  EditTraceEvent,
  TaskSnapshot,
  TaskStatus
} from "@photo-ai/contracts";
import {
  getEvents,
  getTask,
  runPreview
} from "../../services/api";
import { mergeEvents } from "../../services/edit-trace";

type RenderEvent = EditTraceEvent & { text: string };

type Runtime = {
  alive: boolean;
  generation: number;
  pending: RenderEvent[];
  revealTimer: ReturnType<typeof setTimeout> | undefined;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  polling: boolean;
  starting: boolean;
  stopPolling: boolean;
};

const runtimes = new WeakMap<object, Runtime>();
const reduceMotionStorageKey = "photo-ai:reduce-motion";
const failureStatuses = new Set<TaskStatus>([
  "FAILED",
  "REJECTED",
  "CANCELED"
]);

const copy: Record<EditTraceEvent["copyKey"], string> = {
  "portrait.diagnosis.started": "正在分析照片的光线、肤质与主体结构",
  "portrait.diagnosis.light": "检测到面部暗部与背景高光差异",
  "portrait.plan.natural": "已制定保留真实肤质的自然精修方案",
  "portrait.stage.retouch.started": "正在恢复人物局部光影与肤质层次",
  "portrait.parameter.direction": "已应用适中的自然精修方向",
  "portrait.stage.retouch.completed": "人物局部调整已完成",
  "quality.started": "正在检查身份与非目标区域稳定性",
  "quality.identity.failed": "身份一致性检查未通过，正在准备重试",
  "portrait.retry.started": "已开始一次真实的质量重试",
  "portrait.stage.retry.started": "正在重新处理未通过质量检查的阶段",
  "quality.retry.started": "正在复查重试结果",
  "quality.identity.passed": "人物身份一致性检查通过",
  "preview.ready": "水印预览已生成",
  "preview.provider.failed": "水印预览生成失败，任务已停止"
};

function clearTimers(runtime: Runtime): void {
  if (runtime.revealTimer) {
    clearTimeout(runtime.revealTimer);
  }
  if (runtime.pollTimer) {
    clearTimeout(runtime.pollTimer);
  }
  runtime.revealTimer = undefined;
  runtime.pollTimer = undefined;
}

function active(
  page: object,
  runtime: Runtime,
  generation: number
): boolean {
  return runtime.alive &&
    runtime.generation === generation &&
    runtimes.get(page) === runtime;
}

function renderEvent(event: EditTraceEvent): RenderEvent {
  return {
    ...event,
    text: copy[event.copyKey]
  };
}

function eventFailureCode(event: EditTraceEvent): string | undefined {
  if (event.type !== "TASK_FAILED" || !("code" in event.payload)) {
    return undefined;
  }
  return event.payload.code;
}

function readReduceMotionPreference(): boolean {
  try {
    return wx.getStorageSync<unknown>(reduceMotionStorageKey) === true;
  } catch {
    return false;
  }
}

function writeReduceMotionPreference(value: boolean): void {
  try {
    wx.setStorageSync(reduceMotionStorageKey, value);
  } catch {
    // The page-level setting still applies for this session.
  }
}

Page({
  data: {
    taskId: "",
    status: "" as TaskStatus | "",
    allEvents: [] as EditTraceEvent[],
    visibleEvents: [] as RenderEvent[],
    lastSequence: 0,
    ready: false,
    failed: false,
    failureCode: "",
    failureMessage: "",
    noChargeNote: "",
    reduceMotion: false,
    error: ""
  },

  onLoad(options: Record<string, string | undefined>) {
    const taskId = options.taskId;
    if (!taskId) {
      this.setData({
        error: "任务编号缺失，请返回重新创建任务。"
      });
      return;
    }

    const page = this as unknown as object;
    const prior = runtimes.get(page);
    if (prior) {
      prior.alive = false;
      clearTimers(prior);
    }

    const runtime: Runtime = {
      alive: true,
      generation: (prior?.generation ?? 0) + 1,
      pending: [],
      revealTimer: undefined,
      pollTimer: undefined,
      polling: false,
      starting: false,
      stopPolling: false
    };
    runtimes.set(page, runtime);
    this.setData({
      taskId,
      status: "",
      allEvents: [],
      visibleEvents: [],
      lastSequence: 0,
      ready: false,
      failed: false,
      failureCode: "",
      failureMessage: "",
      noChargeNote: "",
      reduceMotion: readReduceMotionPreference(),
      error: ""
    });
    void this.start();
  },

  onUnload() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime) {
      return;
    }

    runtime.alive = false;
    runtime.generation += 1;
    runtime.pending = [];
    clearTimers(runtime);
    runtimes.delete(page);
  },

  async start() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (
      !runtime ||
      !runtime.alive ||
      runtime.starting ||
      runtime.stopPolling
    ) {
      return;
    }

    const generation = runtime.generation;
    runtime.starting = true;
    try {
      const currentTask = await getTask(this.data.taskId);
      if (!active(page, runtime, generation)) {
        return;
      }
      this.setData({ status: currentTask.status });

      if (currentTask.status === "SUCCEEDED") {
        await this.restoreTerminalTask(currentTask, true);
        return;
      }
      if (failureStatuses.has(currentTask.status)) {
        await this.restoreTerminalTask(currentTask, true);
        return;
      }

      if (currentTask.status === "AWAITING_CONFIRMATION") {
        const previewTask = await runPreview(this.data.taskId);
        if (!active(page, runtime, generation)) {
          return;
        }
        this.setData({ status: previewTask.status });

        if (
          previewTask.status === "SUCCEEDED" ||
          failureStatuses.has(previewTask.status)
        ) {
          await this.restoreTerminalTask(
            previewTask,
            previewTask.status !== "SUCCEEDED"
          );
          return;
        }
      }

      await this.poll();
    } catch {
      if (active(page, runtime, generation) && !this.data.failed) {
        this.setData({
          error: "精修任务暂时无法继续，请检查本地 API 后重试。"
        });
      }
    } finally {
      if (active(page, runtime, generation)) {
        runtime.starting = false;
      }
    }
  },

  async restoreTerminalTask(
    snapshot: TaskSnapshot,
    revealImmediately: boolean
  ) {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime) {
      return;
    }
    const generation = runtime.generation;
    const response = await getEvents(this.data.taskId, 0);
    if (!active(page, runtime, generation)) {
      return;
    }

    this.acceptEvents(response.items, response.nextSequence, revealImmediately);

    if (snapshot.status === "SUCCEEDED") {
      runtime.stopPolling = true;
      if (runtime.pollTimer) {
        clearTimeout(runtime.pollTimer);
        runtime.pollTimer = undefined;
      }
      if (revealImmediately) {
        runtime.pending = [];
        if (runtime.revealTimer) {
          clearTimeout(runtime.revealTimer);
          runtime.revealTimer = undefined;
        }
        this.setData({ ready: true, failed: false, error: "" });
      }
      return;
    }

    const failureEvent = response.items.findLast(
      (event) => event.type === "TASK_FAILED"
    );
    this.markFailed(
      snapshot.failureCode ??
        (failureEvent ? eventFailureCode(failureEvent) : undefined) ??
        snapshot.status
    );
  },

  acceptEvents(
    incoming: EditTraceEvent[],
    nextSequence: number,
    revealImmediately: boolean
  ) {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime) {
      return;
    }

    const allEvents = mergeEvents(this.data.allEvents, incoming);
    this.setData({
      allEvents,
      lastSequence: nextSequence
    });

    if (revealImmediately || this.data.reduceMotion) {
      this.flushPendingEvents();
      return;
    }

    const seen = new Set(
      [...this.data.visibleEvents, ...runtime.pending]
        .map((item) => item.eventId)
    );
    runtime.pending.push(
      ...incoming
        .filter((item) => {
          if (seen.has(item.eventId)) {
            return false;
          }
          seen.add(item.eventId);
          return true;
        })
        .map(renderEvent)
    );
    this.revealNext();
  },

  async poll() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (
      !runtime ||
      !runtime.alive ||
      runtime.stopPolling ||
      runtime.polling
    ) {
      return;
    }

    const generation = runtime.generation;
    runtime.polling = true;
    try {
      const response = await getEvents(
        this.data.taskId,
        this.data.lastSequence
      );
      if (!active(page, runtime, generation)) {
        return;
      }

      const failureEvent = response.items.find(
        (item) => item.type === "TASK_FAILED"
      );
      if (failureEvent) {
        this.acceptEvents(
          response.items,
          response.nextSequence,
          true
        );
        this.markFailed(
          eventFailureCode(failureEvent) ?? "TASK_FAILED"
        );
        return;
      }

      this.acceptEvents(
        response.items,
        response.nextSequence,
        false
      );
      if (response.items.some((item) => item.type === "PREVIEW_READY")) {
        runtime.stopPolling = true;
        if (runtime.pollTimer) {
          clearTimeout(runtime.pollTimer);
          runtime.pollTimer = undefined;
        }
        return;
      }

      if (runtime.pollTimer) {
        clearTimeout(runtime.pollTimer);
      }
      runtime.pollTimer = setTimeout(() => {
        runtime.pollTimer = undefined;
        if (active(page, runtime, generation)) {
          void this.poll();
        }
      }, 500);
    } catch {
      if (active(page, runtime, generation)) {
        this.setData({
          error: "无法获取精修进度，请检查网络或本地 API 后重试。"
        });
      }
    } finally {
      if (active(page, runtime, generation)) {
        runtime.polling = false;
      }
    }
  },

  revealNext() {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (
      !runtime ||
      runtime.revealTimer ||
      runtime.pending.length === 0
    ) {
      return;
    }

    if (this.data.reduceMotion) {
      this.flushPendingEvents();
      return;
    }

    const generation = runtime.generation;
    const next = runtime.pending[0];
    if (!next) {
      return;
    }

    runtime.revealTimer = setTimeout(() => {
      runtime.revealTimer = undefined;
      if (!active(page, runtime, generation)) {
        return;
      }
      runtime.pending.shift();
      this.setData({
        visibleEvents: [...this.data.visibleEvents, next],
        ready: next.type === "PREVIEW_READY" || this.data.ready
      });
      this.revealNext();
    }, 420);
  },

  flushPendingEvents() {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime) {
      return;
    }

    if (runtime.revealTimer) {
      clearTimeout(runtime.revealTimer);
      runtime.revealTimer = undefined;
    }
    runtime.pending = [];
    const visibleEvents = this.data.allEvents.map(renderEvent);
    this.setData({
      visibleEvents,
      ready:
        visibleEvents.some((event) => event.type === "PREVIEW_READY") ||
        this.data.ready
    });
  },

  toggleReduceMotion(event: { detail: { value: boolean } }) {
    const reduceMotion = event.detail.value === true;
    writeReduceMotionPreference(reduceMotion);
    this.setData({ reduceMotion });
    if (reduceMotion) {
      this.flushPendingEvents();
    }
  },

  markFailed(failureCode: string) {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime) {
      return;
    }

    runtime.stopPolling = true;
    runtime.pending = [];
    clearTimers(runtime);
    this.setData({
      status: "FAILED",
      ready: false,
      failed: true,
      failureCode,
      failureMessage: "本次水印预览未生成，任务已稳定停止。",
      noChargeNote: "阶段 A 示例任务不产生支付或积分扣费。",
      error: ""
    });
  },

  openPreview() {
    wx.navigateTo({
      url: `/pages/preview/index?taskId=${this.data.taskId}`
    });
  },

  retry() {
    const runtime = runtimes.get(this as unknown as object);
    if (
      !runtime ||
      !runtime.alive ||
      runtime.stopPolling ||
      runtime.starting
    ) {
      return;
    }

    if (runtime.pollTimer) {
      clearTimeout(runtime.pollTimer);
      runtime.pollTimer = undefined;
    }
    this.setData({ error: "" });
    void this.start();
  },

  restart() {
    wx.redirectTo({ url: "/pages/plan/index" });
  },

  goBack() {
    wx.navigateBack({ delta: 1 });
  }
});
