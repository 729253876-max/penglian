import { describe, expect, it } from "vitest";
import type { EditTraceEvent } from "@photo-ai/contracts";
import { mergeEvents } from "../miniprogram/services/edit-trace";

function event(eventId: string, sequence: number): EditTraceEvent {
  return {
    eventId,
    taskId: "task-1",
    sequence,
    type: "STAGE_STARTED",
    phase: "RETOUCH",
    occurredAt: "2026-07-24T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey: "portrait.stage.retouch.started",
    payload: {}
  };
}

describe("mergeEvents", () => {
  it("deduplicates by event id and sorts by sequence", () => {
    expect(mergeEvents(
      [event("evt-2", 2)],
      [event("evt-1", 1), event("evt-2", 2)]
    ).map((item) => item.eventId)).toEqual(["evt-1", "evt-2"]);
  });

  it("does not modify either input collection", () => {
    const current = [event("evt-2", 2)];
    const incoming = [event("evt-1", 1)];
    const originalCurrent = structuredClone(current);
    const originalIncoming = structuredClone(incoming);

    mergeEvents(current, incoming);

    expect(current).toEqual(originalCurrent);
    expect(incoming).toEqual(originalIncoming);
  });

  it("uses the incoming version when event ids conflict", () => {
    const current = [event("evt-1", 1)];
    const incoming = [{ ...event("evt-1", 1), phase: "QUALITY_CHECK" }];

    expect(mergeEvents(current, incoming)).toMatchObject([
      { eventId: "evt-1", phase: "QUALITY_CHECK" }
    ]);
  });

  it("keeps current content when the incremental page is empty", () => {
    const current = [event("evt-1", 1), event("evt-2", 2)];

    expect(mergeEvents(current, [])).toEqual(current);
  });

  it("orders an out-of-order incremental page by sequence", () => {
    expect(mergeEvents(
      [event("evt-4", 4)],
      [event("evt-3", 3), event("evt-1", 1)]
    ).map((item) => item.sequence)).toEqual([1, 3, 4]);
  });

  it("uses event id as a deterministic tie-breaker for equal sequences", () => {
    expect(mergeEvents(
      [event("evt-b", 1)],
      [event("evt-a", 1)]
    ).map((item) => item.eventId)).toEqual(["evt-a", "evt-b"]);
  });
});
