import type { EditTraceEvent, PortraitPlanDirection } from "@photo-ai/contracts";
import { sanitizeEditTraceEvent } from "../domain/edit-trace-policy.js";

interface JournalState {
  count: number;
  lastSequence: number;
  taskId?: string;
  terminal: boolean;
  diagnosisStarted: boolean;
  protectionRecorded: boolean;
  naturalPlanReady: boolean;
  clearPlanReady: boolean;
  selectedDirection?: PortraitPlanDirection;
  stageStarted: boolean;
  stageCompleted: boolean;
  qualityStarted: boolean;
  qualityResult?: "PASSED" | "FAILED";
  retryCount: number;
}

function initialState(): JournalState {
  return {
    count: 0,
    lastSequence: 0,
    terminal: false,
    diagnosisStarted: false,
    protectionRecorded: false,
    naturalPlanReady: false,
    clearPlanReady: false,
    stageStarted: false,
    stageCompleted: false,
    qualityStarted: false,
    retryCount: 0
  };
}

export class RepairJournalService {
  public validateNext(
    history: readonly EditTraceEvent[],
    event: EditTraceEvent
  ): EditTraceEvent {
    const state = initialState();
    for (const historicalEvent of history) {
      this.advance(state, this.parseEvent(historicalEvent));
    }
    const parsedEvent = this.parseEvent(event);
    this.advance(state, parsedEvent);
    return parsedEvent;
  }

  private parseEvent(event: unknown): EditTraceEvent {
    try {
      return sanitizeEditTraceEvent(event);
    } catch {
      throw new Error("TRACE_EVENT_INVALID");
    }
  }

  private advance(state: JournalState, event: EditTraceEvent): void {
    if (event.sequence !== state.lastSequence + 1) {
      throw new Error("TRACE_SEQUENCE_INVALID");
    }
    if (state.taskId && event.taskId !== state.taskId) {
      throw new Error("TRACE_TASK_MISMATCH");
    }
    if (state.terminal) {
      throw new Error("TRACE_TERMINAL_REACHED");
    }
    if (state.count === 0 && event.type !== "ASSET_APPROVED") {
      throw new Error("TRACE_PREREQUISITE_MISSING");
    }
    if (state.count > 0 && event.type === "ASSET_APPROVED") {
      throw new Error("TRACE_DUPLICATE_EVENT");
    }

    switch (event.type) {
      case "ASSET_APPROVED":
        break;
      case "DIAGNOSIS_STARTED":
        this.require(!state.diagnosisStarted && state.count === 1);
        state.diagnosisStarted = true;
        break;
      case "DIAGNOSIS_FINDING":
        this.require(state.diagnosisStarted && !state.protectionRecorded);
        break;
      case "PROTECTION_RECORDED":
        this.require(state.diagnosisStarted && !state.protectionRecorded);
        state.protectionRecorded = true;
        break;
      case "PLAN_READY":
        this.require(state.protectionRecorded && !state.selectedDirection);
        if (event.payload.direction === "NATURAL_RESCUE") {
          if (state.naturalPlanReady) throw new Error("TRACE_DUPLICATE_EVENT");
          state.naturalPlanReady = true;
        } else {
          if (state.clearPlanReady) throw new Error("TRACE_DUPLICATE_EVENT");
          state.clearPlanReady = true;
        }
        break;
      case "PLAN_SELECTED":
        if (state.selectedDirection) throw new Error("TRACE_DUPLICATE_EVENT");
        this.require(state.naturalPlanReady && state.clearPlanReady);
        state.selectedDirection = event.payload.direction;
        break;
      case "STAGE_STARTED":
        this.require(Boolean(state.selectedDirection) && !state.stageStarted && !state.qualityStarted);
        state.stageStarted = true;
        break;
      case "PARAM_DIRECTION_APPLIED":
        this.require(state.stageStarted && !state.stageCompleted);
        if (state.selectedDirection !== event.payload.direction) {
          throw new Error("TRACE_DIRECTION_MISMATCH");
        }
        break;
      case "STAGE_COMPLETED":
        this.require(state.stageStarted && !state.stageCompleted);
        state.stageCompleted = true;
        break;
      case "QUALITY_CHECK_STARTED":
        this.require(state.stageCompleted && !state.qualityStarted);
        state.qualityStarted = true;
        break;
      case "QUALITY_CHECK_PASSED":
      case "QUALITY_CHECK_FAILED":
        this.require(state.qualityStarted && !state.qualityResult);
        state.qualityResult = event.type === "QUALITY_CHECK_PASSED" ? "PASSED" : "FAILED";
        break;
      case "RETRY_STARTED":
        if (state.retryCount >= 1 || event.payload.attempt !== 2) {
          throw new Error("TRACE_RETRY_LIMIT_EXCEEDED");
        }
        this.require(state.qualityResult === "FAILED");
        state.retryCount += 1;
        state.stageStarted = false;
        state.stageCompleted = false;
        state.qualityStarted = false;
        delete state.qualityResult;
        break;
      case "PREVIEW_READY":
        this.require(state.qualityResult === "PASSED");
        state.terminal = true;
        break;
      case "TASK_FAILED":
        this.require(Boolean(state.selectedDirection));
        state.terminal = true;
        break;
    }

    state.count += 1;
    state.lastSequence = event.sequence;
    state.taskId ??= event.taskId;
  }

  private require(condition: boolean): asserts condition {
    if (!condition) throw new Error("TRACE_PREREQUISITE_MISSING");
  }
}
