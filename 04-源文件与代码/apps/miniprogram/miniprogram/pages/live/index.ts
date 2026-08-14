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
import {
  failureEvidence,
  presentTrace,
  successEvidence,
  summarizeTrace,
  type RenderEvent,
  type TraceSummary
} from "../../services/edit-trace-presentation";

type Runtime = {
  alive: boolean;
  generation: number;
  pending: RenderEvent[];
  revealTimer: ReturnType<typeof setTimeout> | undefined;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  polling: boolean;
  starting: boolean;
  stopPolling: boolean;
  refetching: boolean;
};

const runtimes = new WeakMap<object, Runtime>();
const reduceMotionStorageKey = "photo-ai:reduce-motion";
const failureStatuses = new Set<TaskStatus>([
  "FAILED",
  "REJECTED",
  "CANCELED"
]);

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
  return presentTrace([event])[0]!;
}

function validSequence(events: readonly EditTraceEvent[], taskId: string): boolean {
  return events.every((event, index) =>
    event.taskId === taskId && event.sequence === index + 1
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key])
    );
}

function sameEvent(left: EditTraceEvent, right: EditTraceEvent): boolean {
  return left.eventId === right.eventId &&
    left.taskId === right.taskId &&
    left.sequence === right.sequence &&
    left.type === right.type &&
    left.phase === right.phase &&
    left.occurredAt === right.occurredAt &&
    left.visibility === right.visibility &&
    left.evidenceSource === right.evidenceSource &&
    left.copyKey === right.copyKey &&
    sameJsonValue(left.payload, right.payload);
}

function preservesAcceptedPrefix(
  accepted: readonly EditTraceEvent[],
  incoming: readonly EditTraceEvent[]
): boolean {
  return incoming.length >= accepted.length &&
    accepted.every((event, index) => {
      const candidate = incoming[index];
      return candidate !== undefined && sameEvent(event, candidate);
    });
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
    traceSummary: [] as TraceSummary[],
    latestEvent: undefined as RenderEvent | undefined,
    showAllEvents: false,
    lastSequence: 0,
    ready: false,
    failed: false,
    failureCode: "",
    failureMessage: "",
    noChargeNote: "",
    failedChecks: [] as string[],
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
      stopPolling: false,
      refetching: false
    };
    runtimes.set(page, runtime);
    this.setData({
      taskId,
      status: "",
      allEvents: [],
      visibleEvents: [],
      traceSummary: [],
      latestEvent: undefined,
      showAllEvents: false,
      lastSequence: 0,
      ready: false,
      failed: false,
      failureCode: "",
      failureMessage: "",
      noChargeNote: "",
      failedChecks: [],
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

    if (!this.acceptEvents(response.items, response.nextSequence, revealImmediately, true)) {
      this.stopForInvalidJournal();
      return;
    }

    if (snapshot.status === "SUCCEEDED") {
      if (!successEvidence(this.data.taskId, snapshot, response.items, response.nextSequence)) {
        this.stopForInvalidJournal();
        return;
      }
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
      }
      this.setData({ ready: true, failed: false, error: "" });
      return;
    }

    const failure = failureEvidence(this.data.taskId, snapshot, response.items, response.nextSequence);
    if (!failure) {
      this.stopForInvalidJournal();
      return;
    }
    this.markFailed(failure.code, snapshot, failure.failedChecks);
  },

  acceptEvents(
    incoming: EditTraceEvent[],
    nextSequence: number,
    revealImmediately: boolean,
    fullJournal = false
  ): boolean {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime) {
      return false;
    }

    if (fullJournal && !preservesAcceptedPrefix(this.data.allEvents, incoming)) {
      return false;
    }
    const candidate = fullJournal ? incoming : [...this.data.allEvents, ...incoming];
    if (!validSequence(candidate, this.data.taskId) || nextSequence !== candidate.length) {
      return false;
    }

    if (fullJournal) {
      if (runtime.revealTimer) {
        clearTimeout(runtime.revealTimer);
        runtime.revealTimer = undefined;
      }
      runtime.pending = [];
      const allEvents = [...incoming];
      const revealAll = revealImmediately || this.data.reduceMotion;
      const visibleCount = revealAll
        ? allEvents.length
        : Math.min(this.data.visibleEvents.length, allEvents.length);
      const visibleEvents = allEvents.slice(0, visibleCount).map(renderEvent);
      runtime.pending = allEvents.slice(visibleCount).map(renderEvent);
      this.setData({
        allEvents,
        visibleEvents,
        traceSummary: summarizeTrace(allEvents),
        latestEvent: allEvents.length > 0
          ? renderEvent(allEvents[allEvents.length - 1]!)
          : undefined,
        lastSequence: nextSequence
      });
      if (!revealAll) this.revealNext();
      return true;
    }

    const allEvents = fullJournal ? [...incoming] : mergeEvents(this.data.allEvents, incoming);
    this.setData({
      allEvents,
      traceSummary: summarizeTrace(allEvents),
      latestEvent: allEvents.length > 0
        ? renderEvent(allEvents[allEvents.length - 1]!)
        : undefined,
      lastSequence: nextSequence
    });

    if (revealImmediately || this.data.reduceMotion) {
      this.flushPendingEvents();
      return true;
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
    return true;
  },

  stopForInvalidJournal() {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime) return;
    runtime.stopPolling = true;
    runtime.refetching = false;
    runtime.pending = [];
    clearTimers(runtime);
    this.setData({ ready: false, error: "修复记录暂时不完整，请稍后返回重试。" });
  },

  async handleAcceptedJournalOrContinue(
    items: EditTraceEvent[],
    generation: number
  ) {
    const page = this as unknown as object;
    const runtime = runtimes.get(page);
    if (!runtime || !active(page, runtime, generation)) return;

    const failureEvent = items.find((item) => item.type === "TASK_FAILED");
    if (failureEvent) {
      const snapshot = await getTask(this.data.taskId);
      if (!active(page, runtime, generation)) return;
      const failure = failureEvidence(this.data.taskId, snapshot, this.data.allEvents, this.data.lastSequence);
      if (!failure) {
        this.stopForInvalidJournal();
        return;
      }
      this.markFailed(failure.code, snapshot, failure.failedChecks);
      return;
    }
    if (items.some((item) => item.type === "PREVIEW_READY")) {
      const snapshot = await getTask(this.data.taskId);
      if (!active(page, runtime, generation)) return;
      if (!successEvidence(this.data.taskId, snapshot, this.data.allEvents, this.data.lastSequence)) {
        this.stopForInvalidJournal();
        return;
      }
      runtime.stopPolling = true;
      this.flushPendingEvents();
      this.setData({ status: snapshot.status, ready: true, error: "" });
      return;
    }

    if (runtime.pollTimer) clearTimeout(runtime.pollTimer);
    runtime.pollTimer = setTimeout(() => {
      runtime.pollTimer = undefined;
      if (active(page, runtime, generation)) void this.poll();
    }, 500);
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

      if (!this.acceptEvents(response.items, response.nextSequence, false)) {
        if (runtime.refetching) {
          this.stopForInvalidJournal();
          return;
        }
        runtime.refetching = true;
        this.setData({ error: "修复记录暂时不完整，正在重新同步。" });
        const full = await getEvents(this.data.taskId, 0);
        if (!active(page, runtime, generation)) return;
        if (!this.acceptEvents(full.items, full.nextSequence, false, true)) {
          this.stopForInvalidJournal();
          return;
        }
        runtime.refetching = false;
        this.setData({ error: "" });
        response.items = full.items;
        response.nextSequence = full.nextSequence;
      }

      await this.handleAcceptedJournalOrContinue(response.items, generation);
    } catch (error) {
      if (active(page, runtime, generation)) {
        if (error instanceof Error && error.message === "API_RESPONSE_INVALID" && !runtime.refetching) {
          runtime.refetching = true;
          try {
            const full = await getEvents(this.data.taskId, 0);
            if (!active(page, runtime, generation)) return;
            if (!this.acceptEvents(full.items, full.nextSequence, false, true)) {
              this.stopForInvalidJournal();
              return;
            }
            runtime.refetching = false;
            this.setData({ error: "" });
            await this.handleAcceptedJournalOrContinue(full.items, generation);
            return;
          } catch {
            this.stopForInvalidJournal();
            return;
          }
        }
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
        ready: this.data.ready
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
      ready: this.data.ready
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

  toggleAllEvents() {
    this.setData({ showAllEvents: !this.data.showAllEvents });
  },

  markFailed(failureCode: string, snapshot?: TaskSnapshot, failedCheckCodes: string[] = []) {
    const runtime = runtimes.get(this as unknown as object);
    if (!runtime) {
      return;
    }

    runtime.stopPolling = true;
    runtime.pending = [];
    clearTimers(runtime);
    const labels: Record<string, string> = {
      FACE_COUNT: "人物数量", IDENTITY: "人物身份", STRUCTURE: "五官与身体结构",
      NON_TARGET_REGION: "非目标区域", ARTIFACTS: "伪影与生成细节"
    };
    const failedChecks = failedCheckCodes.map((check) => labels[check] ?? check);
    this.setData({
      status: "FAILED",
      ready: false,
      failed: true,
      failureCode,
      failureMessage: failureCode === "FIDELITY_GATE_FAILED"
        ? "无法在保持本人特征的前提下完成。"
        : failureCode === "PREVIEW_PROVIDER_FAILED"
          ? "处理服务暂时不可用，未生成可查看预览。"
          : "本次水印预览未生成，任务已稳定停止。",
      failedChecks,
      noChargeNote: snapshot?.noCharge === true
        ? "本次未生成可查看预览，不扣免费次数或积分。"
        : "",
      error: ""
    });
  },

  openPreview() {
    wx.navigateTo({
      url: `/pages/preview/index?taskId=${encodeURIComponent(this.data.taskId)}`
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
