import { describe, expect, it } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";
import { RepairJournalService } from "../src/application/repair-journal-service.js";

type EventType = EditTraceEvent["type"];

const payloads: Record<EventType, EditTraceEvent["payload"]> = {
  ASSET_APPROVED: { metadataRemoved: true },
  DIAGNOSIS_STARTED: {},
  DIAGNOSIS_FINDING: { finding: "LIGHT_NOISE" },
  PROTECTION_RECORDED: { protections: ["IDENTITY", "FACIAL_STRUCTURE"] },
  PLAN_READY: { direction: "NATURAL_RESCUE" },
  PLAN_SELECTED: { direction: "NATURAL_RESCUE" },
  STAGE_STARTED: { stage: "LOCAL_LIGHT_AND_SKIN" },
  PARAM_DIRECTION_APPLIED: { direction: "NATURAL_RESCUE", level: "MODERATE" },
  STAGE_COMPLETED: { stage: "LOCAL_LIGHT_AND_SKIN" },
  QUALITY_CHECK_STARTED: {},
  QUALITY_CHECK_PASSED: { checks: ["IDENTITY"] },
  QUALITY_CHECK_FAILED: { checks: ["IDENTITY"], failedChecks: ["IDENTITY"] },
  RETRY_STARTED: { attempt: 2 },
  PREVIEW_READY: { watermarked: true, downloadable: false },
  TASK_FAILED: { code: "PREVIEW_PROVIDER_FAILED" }
};

const metadata: Record<EventType, Pick<EditTraceEvent, "phase" | "evidenceSource" | "copyKey">> = {
  ASSET_APPROVED: { phase: "UPLOAD", evidenceSource: "SYSTEM_CHECK", copyKey: "upload.asset.approved" },
  DIAGNOSIS_STARTED: { phase: "DIAGNOSIS", evidenceSource: "SYSTEM_CHECK", copyKey: "portrait.diagnosis.started" },
  DIAGNOSIS_FINDING: { phase: "DIAGNOSIS", evidenceSource: "SYSTEM_CHECK", copyKey: "portrait.diagnosis.light" },
  PROTECTION_RECORDED: { phase: "DIAGNOSIS", evidenceSource: "SYSTEM_CHECK", copyKey: "portrait.protection.recorded" },
  PLAN_READY: { phase: "PLAN", evidenceSource: "SYSTEM_CHECK", copyKey: "portrait.plan.natural" },
  PLAN_SELECTED: { phase: "PLAN", evidenceSource: "USER_SELECTION", copyKey: "portrait.plan.selected" },
  STAGE_STARTED: { phase: "RETOUCH", evidenceSource: "PROVIDER_RECEIPT", copyKey: "portrait.stage.retouch.started" },
  PARAM_DIRECTION_APPLIED: { phase: "RETOUCH", evidenceSource: "PROVIDER_RECEIPT", copyKey: "portrait.parameter.direction" },
  STAGE_COMPLETED: { phase: "RETOUCH", evidenceSource: "PROVIDER_RECEIPT", copyKey: "portrait.stage.retouch.completed" },
  QUALITY_CHECK_STARTED: { phase: "QUALITY", evidenceSource: "QUALITY_GATE", copyKey: "quality.started" },
  QUALITY_CHECK_PASSED: { phase: "QUALITY", evidenceSource: "QUALITY_GATE", copyKey: "quality.fidelity.passed" },
  QUALITY_CHECK_FAILED: { phase: "QUALITY", evidenceSource: "QUALITY_GATE", copyKey: "quality.fidelity.failed" },
  RETRY_STARTED: { phase: "RETOUCH", evidenceSource: "SYSTEM_CHECK", copyKey: "portrait.retry.started" },
  PREVIEW_READY: { phase: "DELIVERY", evidenceSource: "QUALITY_GATE", copyKey: "preview.ready" },
  TASK_FAILED: { phase: "DELIVERY", evidenceSource: "SYSTEM_CHECK", copyKey: "preview.provider.failed" }
};

function event(type: EventType, sequence: number, overrides: Partial<EditTraceEvent> = {}): EditTraceEvent {
  return {
    eventId: `event-${sequence}`,
    taskId: "task-1",
    sequence,
    type,
    occurredAt: "2026-08-12T00:00:00.000Z",
    visibility: "PREVIEW",
    ...metadata[type],
    payload: structuredClone(payloads[type]),
    ...overrides
  } as EditTraceEvent;
}

function creation(findings = 0): EditTraceEvent[] {
  const events = [event("ASSET_APPROVED", 1), event("DIAGNOSIS_STARTED", 2)];
  for (let index = 0; index < findings; index += 1) {
    events.push(event("DIAGNOSIS_FINDING", events.length + 1));
  }
  events.push(event("PROTECTION_RECORDED", events.length + 1));
  events.push(event("PLAN_READY", events.length + 1));
  events.push(event("PLAN_READY", events.length + 1, {
    copyKey: "portrait.plan.clear",
    payload: { direction: "CLEAR_RESCUE" }
  }));
  events.push(event("PLAN_SELECTED", events.length + 1));
  return events;
}

function processed(findings = 0): EditTraceEvent[] {
  const history = creation(findings);
  history.push(event("STAGE_STARTED", history.length + 1));
  history.push(event("STAGE_COMPLETED", history.length + 1));
  return history;
}

describe("RepairJournalService", () => {
  const journal = new RepairJournalService();

  it("requires asset approval as the first event and continuous task-local sequences", () => {
    expect(() => journal.validateNext([], event("DIAGNOSIS_STARTED", 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");
    expect(() => journal.validateNext([event("ASSET_APPROVED", 1)], event("DIAGNOSIS_STARTED", 3)))
      .toThrow("TRACE_SEQUENCE_INVALID");
    expect(() => journal.validateNext([event("ASSET_APPROVED", 1)], event("DIAGNOSIS_STARTED", 2, { taskId: "task-2" })))
      .toThrow("TRACE_TASK_MISMATCH");
    expect(() => journal.validateNext(
      [event("ASSET_APPROVED", 1), event("DIAGNOSIS_STARTED", 3)],
      event("PROTECTION_RECORDED", 4)
    )).toThrow("TRACE_SEQUENCE_INVALID");
  });

  it.each([
    [
      "protection without diagnosis",
      [event("ASSET_APPROVED", 1), event("PROTECTION_RECORDED", 2)]
    ],
    [
      "a quality result without a quality start",
      [
        ...processed(),
        event("QUALITY_CHECK_PASSED", processed().length + 1)
      ]
    ]
  ])("replays and rejects a semantically invalid history containing %s", (_name, invalidHistory) => {
    expect(() => journal.validateNext(
      invalidHistory,
      event("TASK_FAILED", invalidHistory.length + 1)
    )).toThrow("TRACE_PREREQUISITE_MISSING");
  });

  it.each([0, 1, 3])("allows %i diagnosis findings while preserving legal phase order", (findingCount) => {
    const history = creation(findingCount);
    const next = event("STAGE_STARTED", history.length + 1);
    expect(journal.validateNext(history, next)).toBe(next);
  });

  it("requires protection before plans, both distinct plan directions, and one selection", () => {
    expect(() => journal.validateNext(
      [event("ASSET_APPROVED", 1), event("DIAGNOSIS_STARTED", 2)],
      event("PLAN_READY", 3)
    )).toThrow("TRACE_PREREQUISITE_MISSING");

    const onePlan = creation().slice(0, -2);
    expect(() => journal.validateNext(onePlan, event("PLAN_SELECTED", onePlan.length + 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");

    const bothPlans = creation().slice(0, -1);
    expect(() => journal.validateNext(
      bothPlans,
      event("PLAN_READY", bothPlans.length + 1, {
        copyKey: "portrait.plan.clear",
        payload: { direction: "CLEAR_RESCUE" }
      })
    )).toThrow("TRACE_DUPLICATE_EVENT");

    const selected = creation();
    expect(() => journal.validateNext(selected, event("PLAN_SELECTED", selected.length + 1)))
      .toThrow("TRACE_DUPLICATE_EVENT");
  });

  it("allows provider-owned processing receipts only after selection and in stage order", () => {
    expect(() => journal.validateNext(creation().slice(0, -1), event("STAGE_STARTED", 6)))
      .toThrow("TRACE_PREREQUISITE_MISSING");
    const selected = creation();
    expect(() => journal.validateNext(selected, event("PARAM_DIRECTION_APPLIED", selected.length + 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");
    expect(journal.validateNext(selected, event("STAGE_STARTED", selected.length + 1)).type)
      .toBe("STAGE_STARTED");
  });

  it("requires every applied parameter direction to match the unique selected plan", () => {
    const history = creation();
    history.push(event("STAGE_STARTED", history.length + 1));
    const matching = event("PARAM_DIRECTION_APPLIED", history.length + 1);
    const mismatched = event("PARAM_DIRECTION_APPLIED", history.length + 1, {
      payload: { direction: "CLEAR_RESCUE", level: "MODERATE" }
    });

    expect(journal.validateNext(history, matching)).toBe(matching);
    expect(() => journal.validateNext(history, mismatched))
      .toThrow("TRACE_DIRECTION_MISMATCH");
  });

  it("pairs each quality result with a project-owned start for the same attempt", () => {
    const history = processed();
    expect(() => journal.validateNext(history, event("QUALITY_CHECK_STARTED", history.length + 1, {
      evidenceSource: "PROVIDER_RECEIPT"
    } as Partial<EditTraceEvent>))).toThrow("TRACE_AUTHORITY_INVALID");
    expect(() => journal.validateNext(history, event("QUALITY_CHECK_PASSED", history.length + 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");

    history.push(event("QUALITY_CHECK_STARTED", history.length + 1));
    expect(() => journal.validateNext(history, event("QUALITY_CHECK_PASSED", history.length + 1, {
      evidenceSource: "PROVIDER_RECEIPT"
    } as Partial<EditTraceEvent>))).toThrow("TRACE_AUTHORITY_INVALID");
    expect(journal.validateNext(history, event("QUALITY_CHECK_PASSED", history.length + 1)).type)
      .toBe("QUALITY_CHECK_PASSED");
  });

  it("allows one retry at attempt 2 only after the first quality failure", () => {
    const history = processed();
    history.push(event("QUALITY_CHECK_STARTED", history.length + 1));
    expect(() => journal.validateNext(history, event("RETRY_STARTED", history.length + 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");
    history.push(event("QUALITY_CHECK_FAILED", history.length + 1));
    history.push(event("RETRY_STARTED", history.length + 1));
    expect(() => journal.validateNext(history, event("RETRY_STARTED", history.length + 1)))
      .toThrow("TRACE_RETRY_LIMIT_EXCEEDED");
  });

  it("explicitly rejects an attempt 3 retry payload even when passed as an unsafe runtime event", () => {
    const history = processed();
    history.push(event("QUALITY_CHECK_STARTED", history.length + 1));
    history.push(event("QUALITY_CHECK_FAILED", history.length + 1));
    expect(() => journal.validateNext(history, event("RETRY_STARTED", history.length + 1, {
      payload: { attempt: 3 }
    } as unknown as Partial<EditTraceEvent>))).toThrow("TRACE_RETRY_LIMIT_EXCEEDED");
  });

  it("requires the last quality result to pass before preview", () => {
    const history = processed();
    expect(() => journal.validateNext(history, event("PREVIEW_READY", history.length + 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");
    history.push(event("QUALITY_CHECK_STARTED", history.length + 1));
    history.push(event("QUALITY_CHECK_FAILED", history.length + 1));
    expect(() => journal.validateNext(history, event("PREVIEW_READY", history.length + 1)))
      .toThrow("TRACE_PREREQUISITE_MISSING");
  });

  it.each(["PREVIEW_READY", "TASK_FAILED"] as const)("rejects duplicate or appended events after terminal %s", (terminal) => {
    const history = processed();
    if (terminal === "PREVIEW_READY") {
      history.push(event("QUALITY_CHECK_STARTED", history.length + 1));
      history.push(event("QUALITY_CHECK_PASSED", history.length + 1));
    }
    history.push(event(terminal, history.length + 1));
    expect(() => journal.validateNext(history, event(terminal, history.length + 1)))
      .toThrow("TRACE_TERMINAL_REACHED");
    expect(() => journal.validateNext(history, event("TASK_FAILED", history.length + 1)))
      .toThrow("TRACE_TERMINAL_REACHED");
  });
});
