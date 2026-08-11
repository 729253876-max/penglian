import { describe, expect, it } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";
import { summarizeTrace } from "../miniprogram/services/edit-trace-presentation";

function event(
  phase: EditTraceEvent["phase"],
  sequence: number,
  type: EditTraceEvent["type"]
): EditTraceEvent {
  return {
    eventId: `event-${sequence}`,
    taskId: "task-1",
    sequence,
    type,
    phase,
    occurredAt: "2026-08-12T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey: "portrait.stage.retouch.started",
    payload: {}
  } as EditTraceEvent;
}

describe("summarizeTrace", () => {
  it("summarizes only phases present in real server events", () => {
    const summary = summarizeTrace([
      event("DIAGNOSIS", 1, "DIAGNOSIS_STARTED"),
      event("RETOUCH", 2, "STAGE_STARTED"),
      event("DELIVERY", 3, "PREVIEW_READY")
    ]);

    expect(summary.map((item) => item.phase)).toEqual([
      "DIAGNOSIS",
      "RETOUCH",
      "DELIVERY"
    ]);
    expect(summary.every((item) => item.sourceEventIds.length > 0)).toBe(true);
  });

  it("does not claim a quality check completed without a real QUALITY event", () => {
    const summary = summarizeTrace([
      event("RETOUCH", 1, "STAGE_STARTED"),
      event("DELIVERY", 2, "PREVIEW_READY")
    ]);

    expect(summary.map((item) => item.phase)).not.toContain("QUALITY");
  });

  it("orders phases by their first real sequence and marks a failed phase", () => {
    const summary = summarizeTrace([
      event("RETOUCH", 4, "STAGE_STARTED"),
      event("DELIVERY", 6, "TASK_FAILED"),
      event("DIAGNOSIS", 2, "DIAGNOSIS_STARTED"),
      event("DELIVERY", 5, "PREVIEW_READY")
    ]);

    expect(summary).toMatchObject([
      { phase: "DIAGNOSIS", latestSequence: 2, status: "ACTIVE" },
      { phase: "RETOUCH", latestSequence: 4, status: "ACTIVE" },
      { phase: "DELIVERY", latestSequence: 6, status: "FAILED" }
    ]);
  });
});
