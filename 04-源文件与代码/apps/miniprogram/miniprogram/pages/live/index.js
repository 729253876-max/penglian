import { getEvents, getTask, runPreview } from "../../services/api";
import { mergeEvents } from "../../services/edit-trace";
import { presentTrace, summarizeTrace } from "../../services/edit-trace-presentation";
const runtimes = new WeakMap();
const reduceMotionStorageKey = "photo-ai:reduce-motion";
const failureStatuses = new Set([
    "FAILED",
    "REJECTED",
    "CANCELED"
]);
function clearTimers(runtime) {
    if (runtime.revealTimer) {
        clearTimeout(runtime.revealTimer);
    }
    if (runtime.pollTimer) {
        clearTimeout(runtime.pollTimer);
    }
    runtime.revealTimer = undefined;
    runtime.pollTimer = undefined;
}
function active(page, runtime, generation) {
    return runtime.alive &&
        runtime.generation === generation &&
        runtimes.get(page) === runtime;
}
function renderEvent(event) {
    return presentTrace([event])[0];
}
function validSequence(events, taskId) {
    return events.every((event, index) => event.taskId === taskId && event.sequence === index + 1);
}
function hasReadyEvidence(events) {
    const qualityIndex = events.findLastIndex((event) => event.type === "QUALITY_CHECK_PASSED" && event.evidenceSource === "QUALITY_GATE");
    const readyIndex = events.findLastIndex((event) => event.type === "PREVIEW_READY" && event.evidenceSource === "QUALITY_GATE");
    return qualityIndex >= 0 && readyIndex === events.length - 1 && qualityIndex < readyIndex;
}
function eventFailureCode(event) {
    if (event.type !== "TASK_FAILED" || !("code" in event.payload)) {
        return undefined;
    }
    return event.payload.code;
}
function readReduceMotionPreference() {
    try {
        return wx.getStorageSync(reduceMotionStorageKey) === true;
    }
    catch {
        return false;
    }
}
function writeReduceMotionPreference(value) {
    try {
        wx.setStorageSync(reduceMotionStorageKey, value);
    }
    catch {
        // The page-level setting still applies for this session.
    }
}
Page({
    data: {
        taskId: "",
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
        reduceMotion: false,
        error: ""
    },
    onLoad(options) {
        const taskId = options.taskId;
        if (!taskId) {
            this.setData({
                error: "任务编号缺失，请返回重新创建任务。"
            });
            return;
        }
        const page = this;
        const prior = runtimes.get(page);
        if (prior) {
            prior.alive = false;
            clearTimers(prior);
        }
        const runtime = {
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
        const page = this;
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
        const page = this;
        const runtime = runtimes.get(page);
        if (!runtime ||
            !runtime.alive ||
            runtime.starting ||
            runtime.stopPolling) {
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
                if (previewTask.status === "SUCCEEDED" ||
                    failureStatuses.has(previewTask.status)) {
                    await this.restoreTerminalTask(previewTask, previewTask.status !== "SUCCEEDED");
                    return;
                }
            }
            await this.poll();
        }
        catch {
            if (active(page, runtime, generation) && !this.data.failed) {
                this.setData({
                    error: "精修任务暂时无法继续，请检查本地 API 后重试。"
                });
            }
        }
        finally {
            if (active(page, runtime, generation)) {
                runtime.starting = false;
            }
        }
    },
    async restoreTerminalTask(snapshot, revealImmediately) {
        const page = this;
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
            if (!snapshot.previewUrl || !hasReadyEvidence(response.items)) {
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
                this.setData({ ready: true, failed: false, error: "" });
            }
            return;
        }
        const failureEvent = response.items.findLast((event) => event.type === "TASK_FAILED");
        this.markFailed(snapshot.failureCode ??
            (failureEvent ? eventFailureCode(failureEvent) : undefined) ??
            snapshot.status, snapshot, response.items);
    },
    acceptEvents(incoming, nextSequence, revealImmediately, fullJournal = false) {
        const runtime = runtimes.get(this);
        if (!runtime) {
            return false;
        }
        const candidate = fullJournal ? incoming : [...this.data.allEvents, ...incoming];
        if (!validSequence(candidate, this.data.taskId) || nextSequence !== candidate.length) {
            return false;
        }
        const allEvents = fullJournal ? [...incoming] : mergeEvents(this.data.allEvents, incoming);
        this.setData({
            allEvents,
            traceSummary: summarizeTrace(allEvents),
            latestEvent: allEvents.length > 0
                ? renderEvent(allEvents[allEvents.length - 1])
                : undefined,
            lastSequence: nextSequence
        });
        if (revealImmediately || this.data.reduceMotion) {
            this.flushPendingEvents();
            return true;
        }
        const seen = new Set([...this.data.visibleEvents, ...runtime.pending]
            .map((item) => item.eventId));
        runtime.pending.push(...incoming
            .filter((item) => {
            if (seen.has(item.eventId)) {
                return false;
            }
            seen.add(item.eventId);
            return true;
        })
            .map(renderEvent));
        this.revealNext();
        return true;
    },
    stopForInvalidJournal() {
        const runtime = runtimes.get(this);
        if (!runtime)
            return;
        runtime.stopPolling = true;
        runtime.refetching = false;
        runtime.pending = [];
        clearTimers(runtime);
        this.setData({ ready: false, error: "修复记录暂时不完整，请稍后返回重试。" });
    },
    async poll() {
        const page = this;
        const runtime = runtimes.get(page);
        if (!runtime ||
            !runtime.alive ||
            runtime.stopPolling ||
            runtime.polling) {
            return;
        }
        const generation = runtime.generation;
        runtime.polling = true;
        try {
            const response = await getEvents(this.data.taskId, this.data.lastSequence);
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
                if (!active(page, runtime, generation))
                    return;
                if (!this.acceptEvents(full.items, full.nextSequence, false, true)) {
                    this.stopForInvalidJournal();
                    return;
                }
                runtime.refetching = false;
                this.setData({ error: "" });
                response.items = full.items;
                response.nextSequence = full.nextSequence;
            }
            const failureEvent = response.items.find((item) => item.type === "TASK_FAILED");
            if (failureEvent) {
                this.markFailed(eventFailureCode(failureEvent) ?? "TASK_FAILED", undefined, this.data.allEvents);
                return;
            }
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
        }
        catch {
            if (active(page, runtime, generation)) {
                this.setData({
                    error: "无法获取精修进度，请检查网络或本地 API 后重试。"
                });
            }
        }
        finally {
            if (active(page, runtime, generation)) {
                runtime.polling = false;
            }
        }
    },
    revealNext() {
        const page = this;
        const runtime = runtimes.get(page);
        if (!runtime ||
            runtime.revealTimer ||
            runtime.pending.length === 0) {
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
        const runtime = runtimes.get(this);
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
            ready: visibleEvents.some((event) => event.type === "PREVIEW_READY") ||
                this.data.ready
        });
    },
    toggleReduceMotion(event) {
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
    markFailed(failureCode, snapshot, events = []) {
        const runtime = runtimes.get(this);
        if (!runtime) {
            return;
        }
        runtime.stopPolling = true;
        runtime.pending = [];
        clearTimers(runtime);
        const failedEvent = events.findLast((event) => event.type === "QUALITY_CHECK_FAILED");
        const labels = {
            FACE_COUNT: "人物数量", IDENTITY: "人物身份", STRUCTURE: "五官与身体结构",
            NON_TARGET_REGION: "非目标区域", ARTIFACTS: "伪影与生成细节"
        };
        const failedChecks = failedEvent && "failedChecks" in failedEvent.payload
            ? failedEvent.payload.failedChecks.map((check) => labels[check] ?? check)
            : [];
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
            url: `/pages/preview/index?taskId=${this.data.taskId}`
        });
    },
    retry() {
        const runtime = runtimes.get(this);
        if (!runtime ||
            !runtime.alive ||
            runtime.stopPolling ||
            runtime.starting) {
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
