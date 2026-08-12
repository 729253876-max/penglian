import type { EditTraceEvent } from "@photo-ai/contracts";

const terminalTypes = new Set<EditTraceEvent["type"]>([
  "PREVIEW_READY",
  "TASK_FAILED"
]);

export class RepairJournalService {
  public validateNext(
    history: readonly EditTraceEvent[],
    event: EditTraceEvent
  ): EditTraceEvent {
    const verifiedPrefix: EditTraceEvent[] = [];
    for (const historicalEvent of history) {
      this.validateAppend(verifiedPrefix, historicalEvent);
      verifiedPrefix.push(historicalEvent);
    }
    return this.validateAppend(verifiedPrefix, event);
  }

  private validateAppend(
    history: readonly EditTraceEvent[],
    event: EditTraceEvent
  ): EditTraceEvent {
    const previous = history.at(-1);
    if (event.sequence !== (previous?.sequence ?? 0) + 1) {
      throw new Error("TRACE_SEQUENCE_INVALID");
    }
    if (previous && event.taskId !== previous.taskId) {
      throw new Error("TRACE_TASK_MISMATCH");
    }
    if (history.some((item) => terminalTypes.has(item.type))) {
      throw new Error("TRACE_TERMINAL_REACHED");
    }
    if (history.length === 0) {
      if (event.type !== "ASSET_APPROVED") {
        throw new Error("TRACE_PREREQUISITE_MISSING");
      }
      return event;
    }
    if (event.type === "ASSET_APPROVED") {
      throw new Error("TRACE_DUPLICATE_EVENT");
    }

    const has = (type: EditTraceEvent["type"]): boolean =>
      history.some((item) => item.type === type);
    const count = (type: EditTraceEvent["type"]): number =>
      history.filter((item) => item.type === type).length;
    const retryCount = count("RETRY_STARTED");
    const attemptStart = history.findLastIndex((item) => item.type === "RETRY_STARTED") + 1;
    const attemptHistory = history.slice(attemptStart);
    const attemptHas = (type: EditTraceEvent["type"]): boolean =>
      attemptHistory.some((item) => item.type === type);
    const lastQualityResult = history.findLast((item) =>
      item.type === "QUALITY_CHECK_PASSED" || item.type === "QUALITY_CHECK_FAILED"
    );

    switch (event.type) {
      case "DIAGNOSIS_STARTED":
        this.require(!has("DIAGNOSIS_STARTED") && previous?.type === "ASSET_APPROVED");
        break;
      case "DIAGNOSIS_FINDING":
        this.require(has("DIAGNOSIS_STARTED") && !has("PROTECTION_RECORDED"));
        break;
      case "PROTECTION_RECORDED":
        this.require(has("DIAGNOSIS_STARTED") && !has("PROTECTION_RECORDED"));
        break;
      case "PLAN_READY": {
        this.require(has("PROTECTION_RECORDED") && !has("PLAN_SELECTED"));
        const direction = event.payload.direction;
        if (history.some((item) =>
          item.type === "PLAN_READY" && item.payload.direction === direction
        )) {
          throw new Error("TRACE_DUPLICATE_EVENT");
        }
        break;
      }
      case "PLAN_SELECTED": {
        if (has("PLAN_SELECTED")) throw new Error("TRACE_DUPLICATE_EVENT");
        const directions = new Set(history.flatMap((item) =>
          item.type === "PLAN_READY" ? [item.payload.direction] : []
        ));
        this.require(directions.has("NATURAL_RESCUE") && directions.has("CLEAR_RESCUE"));
        break;
      }
      case "STAGE_STARTED":
        this.require(has("PLAN_SELECTED") && !attemptHas("STAGE_STARTED") && !attemptHas("QUALITY_CHECK_STARTED"));
        break;
      case "PARAM_DIRECTION_APPLIED":
        this.require(attemptHas("STAGE_STARTED") && !attemptHas("STAGE_COMPLETED"));
        if (history.find((item) => item.type === "PLAN_SELECTED")?.payload.direction !==
          event.payload.direction) {
          throw new Error("TRACE_DIRECTION_MISMATCH");
        }
        break;
      case "STAGE_COMPLETED":
        this.require(attemptHas("STAGE_STARTED") && !attemptHas("STAGE_COMPLETED"));
        break;
      case "QUALITY_CHECK_STARTED":
        if (event.evidenceSource !== "QUALITY_GATE") {
          throw new Error("TRACE_AUTHORITY_INVALID");
        }
        this.require(attemptHas("STAGE_COMPLETED") && !attemptHas("QUALITY_CHECK_STARTED"));
        break;
      case "QUALITY_CHECK_PASSED":
      case "QUALITY_CHECK_FAILED":
        if (event.evidenceSource !== "QUALITY_GATE") {
          throw new Error("TRACE_AUTHORITY_INVALID");
        }
        this.require(attemptHas("QUALITY_CHECK_STARTED") &&
          !attemptHas("QUALITY_CHECK_PASSED") && !attemptHas("QUALITY_CHECK_FAILED"));
        break;
      case "RETRY_STARTED":
        if (retryCount >= 1 || event.payload.attempt !== 2) {
          throw new Error("TRACE_RETRY_LIMIT_EXCEEDED");
        }
        this.require(lastQualityResult?.type === "QUALITY_CHECK_FAILED");
        break;
      case "PREVIEW_READY":
        this.require(lastQualityResult?.type === "QUALITY_CHECK_PASSED" &&
          attemptHas("QUALITY_CHECK_PASSED"));
        break;
      case "TASK_FAILED":
        this.require(has("PLAN_SELECTED"));
        break;
    }

    return event;
  }

  private require(condition: boolean): asserts condition {
    if (!condition) throw new Error("TRACE_PREREQUISITE_MISSING");
  }
}
