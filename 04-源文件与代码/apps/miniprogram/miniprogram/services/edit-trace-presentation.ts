import type { EditTraceEvent } from "@photo-ai/contracts";

export interface TraceSummary {
  phase: EditTraceEvent["phase"];
  latestSequence: number;
  sourceEventIds: string[];
  status: "ACTIVE" | "COMPLETED" | "FAILED";
}

const completedEventTypes = new Set<EditTraceEvent["type"]>([
  "PLAN_READY",
  "STAGE_COMPLETED",
  "QUALITY_CHECK_PASSED",
  "PREVIEW_READY"
]);

export function summarizeTrace(
  events: readonly EditTraceEvent[]
): TraceSummary[] {
  const byPhase = new Map<EditTraceEvent["phase"], EditTraceEvent[]>();

  for (const event of events) {
    const phaseEvents = byPhase.get(event.phase) ?? [];
    phaseEvents.push(event);
    byPhase.set(event.phase, phaseEvents);
  }

  const summaries = [...byPhase.values()].map((phaseEvents) => {
    const orderedEvents = [...phaseEvents].sort(
      (left, right) => left.sequence - right.sequence
    );
    const latestEvent = orderedEvents[orderedEvents.length - 1]!;

    return {
      firstSequence: orderedEvents[0]!.sequence,
      phase: latestEvent.phase,
      latestSequence: latestEvent.sequence,
      sourceEventIds: orderedEvents.map((event) => event.eventId),
      status: orderedEvents.some((event) => event.type === "TASK_FAILED")
        ? "FAILED" as const
        : completedEventTypes.has(latestEvent.type)
          ? "COMPLETED" as const
          : "ACTIVE" as const
    };
  });

  return summaries
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map(({ firstSequence: _, ...summary }): TraceSummary => summary);
}
