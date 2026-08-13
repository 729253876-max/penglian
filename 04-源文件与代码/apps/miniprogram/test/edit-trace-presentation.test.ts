import { describe, expect, it } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";
import { presentTrace, summarizeTrace } from "../miniprogram/services/edit-trace-presentation";

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
      { phase: "DIAGNOSIS", latestSequence: 2, status: "COMPLETED" },
      { phase: "RETOUCH", latestSequence: 4, status: "COMPLETED" },
      { phase: "DELIVERY", latestSequence: 6, status: "FAILED" }
    ]);
  });

  it("marks historical phases completed in a full successful real-event flow", () => {
    const summary = summarizeTrace([
      event("DIAGNOSIS", 1, "DIAGNOSIS_STARTED"),
      event("DIAGNOSIS", 2, "DIAGNOSIS_FINDING"),
      event("PLAN", 3, "PLAN_READY"),
      event("RETOUCH", 4, "STAGE_STARTED"),
      event("RETOUCH", 5, "STAGE_COMPLETED"),
      event("QUALITY", 6, "QUALITY_CHECK_STARTED"),
      event("QUALITY", 7, "QUALITY_CHECK_PASSED"),
      event("DELIVERY", 8, "PREVIEW_READY")
    ]);

    expect(summary.map(({ phase, status }) => ({ phase, status }))).toEqual([
      { phase: "DIAGNOSIS", status: "COMPLETED" },
      { phase: "PLAN", status: "COMPLETED" },
      { phase: "RETOUCH", status: "COMPLETED" },
      { phase: "QUALITY", status: "COMPLETED" },
      { phase: "DELIVERY", status: "COMPLETED" }
    ]);
  });

  it("uses later real phases to complete history while a quality retry remains active", () => {
    const summary = summarizeTrace([
      event("DIAGNOSIS", 1, "DIAGNOSIS_STARTED"),
      event("PLAN", 2, "PLAN_READY"),
      event("RETOUCH", 3, "STAGE_STARTED"),
      event("RETOUCH", 4, "STAGE_COMPLETED"),
      event("QUALITY", 5, "QUALITY_CHECK_STARTED"),
      event("QUALITY", 6, "QUALITY_CHECK_FAILED"),
      event("RETOUCH", 7, "RETRY_STARTED"),
      event("RETOUCH", 8, "STAGE_STARTED")
    ]);

    expect(summary.map(({ phase, status }) => ({ phase, status }))).toEqual([
      { phase: "DIAGNOSIS", status: "COMPLETED" },
      { phase: "PLAN", status: "COMPLETED" },
      { phase: "RETOUCH", status: "ACTIVE" },
      { phase: "QUALITY", status: "COMPLETED" }
    ]);
  });

  it("retains every same-phase source event ID in sequence order", () => {
    const summary = summarizeTrace([
      event("RETOUCH", 4, "STAGE_COMPLETED"),
      event("RETOUCH", 2, "STAGE_STARTED"),
      event("RETOUCH", 3, "PARAM_DIRECTION_APPLIED")
    ]);

    expect(summary).toEqual([
      {
        phase: "RETOUCH",
        latestSequence: 4,
        sourceEventIds: ["event-2", "event-3", "event-4"],
        status: "COMPLETED"
      }
    ]);
  });
});

describe("presentTrace", () => {
  it("keeps all 15 public server event types in sequence with four public evidence labels", () => {
    const types: EditTraceEvent["type"][] = [
      "ASSET_APPROVED", "DIAGNOSIS_STARTED", "DIAGNOSIS_FINDING",
      "PROTECTION_RECORDED", "PLAN_READY", "PLAN_SELECTED", "STAGE_STARTED",
      "PARAM_DIRECTION_APPLIED", "STAGE_COMPLETED", "QUALITY_CHECK_STARTED",
      "QUALITY_CHECK_PASSED", "QUALITY_CHECK_FAILED", "RETRY_STARTED",
      "PREVIEW_READY", "TASK_FAILED"
    ];
    const phases: EditTraceEvent["phase"][] = [
      "UPLOAD", "DIAGNOSIS", "DIAGNOSIS", "DIAGNOSIS", "PLAN", "PLAN",
      "RETOUCH", "RETOUCH", "RETOUCH", "QUALITY", "QUALITY", "QUALITY",
      "RETOUCH", "DELIVERY", "DELIVERY"
    ];
    const journal = types.map((type, index) => ({
      ...event(phases[index]!, index + 1, type),
      evidenceSource: type === "PLAN_SELECTED"
        ? "USER_SELECTION"
        : type.startsWith("QUALITY_") || type === "PREVIEW_READY"
          ? "QUALITY_GATE"
          : ["STAGE_STARTED", "PARAM_DIRECTION_APPLIED", "STAGE_COMPLETED"].includes(type)
            ? "PROVIDER_RECEIPT"
            : "SYSTEM_CHECK"
    })) as EditTraceEvent[];

    const rendered = presentTrace(journal);

    expect(rendered.map((item) => item.sequence)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1)
    );
    expect(new Set(rendered.map((item) => item.evidenceLabel))).toEqual(new Set([
      "系统检测", "用户选择", "处理服务回执", "项目质量检查"
    ]));
    expect(rendered.every((item) => item.text.length > 0)).toBe(true);
  });
});
