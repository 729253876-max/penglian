import { describe, expect, it } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";
import { failureEvidence, presentTrace, successEvidence, summarizeTrace } from "../miniprogram/services/edit-trace-presentation";

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

function truthfulEvent(
  sequence: number,
  type: EditTraceEvent["type"],
  phase: EditTraceEvent["phase"],
  evidenceSource: EditTraceEvent["evidenceSource"],
  copyKey: EditTraceEvent["copyKey"],
  payload: EditTraceEvent["payload"]
): EditTraceEvent {
  return {
    eventId: `truthful-${sequence}`,
    taskId: "task-1",
    sequence,
    type,
    phase,
    occurredAt: "2026-08-12T00:00:00.000Z",
    visibility: "PREVIEW",
    evidenceSource,
    copyKey,
    payload
  } as EditTraceEvent;
}

function successfulJournal(): EditTraceEvent[] {
  return [
    truthfulEvent(1, "ASSET_APPROVED", "UPLOAD", "SYSTEM_CHECK", "upload.asset.approved", { metadataRemoved: true }),
    truthfulEvent(2, "DIAGNOSIS_STARTED", "DIAGNOSIS", "SYSTEM_CHECK", "portrait.diagnosis.started", {}),
    truthfulEvent(3, "DIAGNOSIS_FINDING", "DIAGNOSIS", "SYSTEM_CHECK", "portrait.diagnosis.light", { finding: "LIGHT_NOISE" }),
    truthfulEvent(4, "PROTECTION_RECORDED", "DIAGNOSIS", "SYSTEM_CHECK", "portrait.protection.recorded", { protections: ["IDENTITY"] }),
    truthfulEvent(5, "PLAN_READY", "PLAN", "SYSTEM_CHECK", "portrait.plan.natural", { direction: "NATURAL_RESCUE" }),
    truthfulEvent(6, "PLAN_READY", "PLAN", "SYSTEM_CHECK", "portrait.plan.clear", { direction: "CLEAR_RESCUE" }),
    truthfulEvent(7, "PLAN_SELECTED", "PLAN", "USER_SELECTION", "portrait.plan.selected", { direction: "NATURAL_RESCUE" }),
    truthfulEvent(8, "STAGE_STARTED", "RETOUCH", "PROVIDER_RECEIPT", "portrait.stage.retouch.started", { stage: "LOCAL_LIGHT_AND_SKIN" }),
    truthfulEvent(9, "PARAM_DIRECTION_APPLIED", "RETOUCH", "PROVIDER_RECEIPT", "portrait.parameter.direction", { direction: "NATURAL_RESCUE", level: "MODERATE" }),
    truthfulEvent(10, "STAGE_COMPLETED", "RETOUCH", "PROVIDER_RECEIPT", "portrait.stage.retouch.completed", { stage: "LOCAL_LIGHT_AND_SKIN" }),
    truthfulEvent(11, "QUALITY_CHECK_STARTED", "QUALITY", "QUALITY_GATE", "quality.started", {}),
    truthfulEvent(12, "QUALITY_CHECK_PASSED", "QUALITY", "QUALITY_GATE", "quality.fidelity.passed", { checks: ["IDENTITY"] }),
    truthfulEvent(13, "PREVIEW_READY", "DELIVERY", "QUALITY_GATE", "preview.ready", { watermarked: true, downloadable: false })
  ];
}

function fidelityFailureJournal(): EditTraceEvent[] {
  return [
    ...successfulJournal().slice(0, -2),
    truthfulEvent(12, "QUALITY_CHECK_FAILED", "QUALITY", "QUALITY_GATE", "quality.fidelity.failed", {
      checks: ["IDENTITY", "ARTIFACTS"],
      failedChecks: ["IDENTITY", "ARTIFACTS"]
    }),
    truthfulEvent(13, "TASK_FAILED", "DELIVERY", "QUALITY_GATE", "preview.provider.failed", {
      code: "FIDELITY_GATE_FAILED"
    })
  ];
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

describe("terminal evidence", () => {
  const snapshot = {
    taskId: "task-1",
    status: "SUCCEEDED",
    tool: "PORTRAIT_RETOUCH",
    lastSequence: 13,
    previewUrl: "https://example.invalid/p.jpg"
  } as const;

  it("accepts an aligned succeeded snapshot only with the complete truthful journal", () => {
    expect(successEvidence("task-1", snapshot, successfulJournal(), 13)).toBe(true);
  });

  it.each([
    ["asset approval", new Set(["ASSET_APPROVED"])],
    ["diagnosis", new Set(["DIAGNOSIS_STARTED", "DIAGNOSIS_FINDING", "PROTECTION_RECORDED"])],
    ["plan selection", new Set(["PLAN_SELECTED"])],
    ["provider stage", new Set(["STAGE_STARTED", "PARAM_DIRECTION_APPLIED", "STAGE_COMPLETED"])],
    ["quality start", new Set(["QUALITY_CHECK_STARTED"])]
  ])("rejects a success journal missing %s", (_name, removedTypes) => {
    const incomplete = successfulJournal()
      .filter((item) => !removedTypes.has(item.type))
      .map((item, index) => ({
        ...item,
        eventId: `incomplete-${index + 1}`,
        sequence: index + 1
      })) as EditTraceEvent[];
    expect(successEvidence(
      "task-1",
      { ...snapshot, lastSequence: incomplete.length },
      incomplete,
      incomplete.length
    )).toBe(false);
  });

  it("uses the final TASK_FAILED code and nearest failed checks from a complete failure journal", () => {
    const failedSnapshot = {
      taskId: "task-1",
      status: "FAILED",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 13,
      failureCode: "FIDELITY_GATE_FAILED",
      noCharge: true
    } as const;
    const journal = fidelityFailureJournal();
    expect(failureEvidence("task-1", failedSnapshot, journal, 13)).toEqual({
      code: "FIDELITY_GATE_FAILED",
      failedChecks: ["IDENTITY", "ARTIFACTS"]
    });
    expect(failureEvidence(
      "task-1",
      { ...failedSnapshot, status: "PROCESSING", failureCode: undefined, noCharge: undefined } as any,
      journal,
      13
    )).toBeUndefined();
    expect(failureEvidence(
      "task-1",
      { ...failedSnapshot, failureCode: "PREVIEW_PROVIDER_FAILED" } as any,
      journal,
      13
    )).toBeUndefined();
  });
});
