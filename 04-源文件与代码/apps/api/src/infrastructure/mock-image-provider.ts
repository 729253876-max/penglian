import type {
  CreateTaskInput,
  EditTraceEvent
} from "@photo-ai/contracts";
import type {
  ImageProvider,
  ProviderRunResult
} from "../application/task-service.js";

type ProviderEvent = Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">;

const simulatedOccurredAt = "2026-07-24T00:00:00.000Z";

function simulatedEvent(
  event: Omit<ProviderEvent, "occurredAt">
): ProviderEvent {
  return { ...event, occurredAt: simulatedOccurredAt };
}

export class MockImageProvider implements ImageProvider {
  public async runPreview(input: CreateTaskInput): Promise<ProviderRunResult> {
    if (input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("MOCK_PROVIDER_UNSUPPORTED_TOOL");
    }

    return {
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
      events: [
        simulatedEvent({
          type: "STAGE_STARTED",
          phase: "RETOUCH",
          visibility: "PREVIEW",
          copyKey: "portrait.stage.retouch.started",
          payload: { stage: "LOCAL_LIGHT_AND_SKIN" }
        }),
        simulatedEvent({
          type: "PARAM_DIRECTION_APPLIED",
          phase: "RETOUCH",
          visibility: "PREVIEW",
          copyKey: "portrait.parameter.direction",
          payload: { direction: input.direction, level: "MODERATE" }
        }),
        simulatedEvent({
          type: "STAGE_COMPLETED",
          phase: "RETOUCH",
          visibility: "PREVIEW",
          copyKey: "portrait.stage.retouch.completed",
          payload: { stage: "LOCAL_LIGHT_AND_SKIN" }
        }),
        simulatedEvent({
          type: "QUALITY_CHECK_STARTED",
          phase: "QUALITY",
          visibility: "PREVIEW",
          copyKey: "quality.started",
          payload: {}
        }),
        simulatedEvent({
          type: "QUALITY_CHECK_PASSED",
          phase: "QUALITY",
          visibility: "PREVIEW",
          copyKey: "quality.identity.passed",
          payload: { check: "IDENTITY_CONSISTENCY" }
        }),
        simulatedEvent({
          type: "PREVIEW_READY",
          phase: "DELIVERY",
          visibility: "PREVIEW",
          copyKey: "preview.ready",
          payload: { watermarked: true, downloadable: false }
        })
      ]
    };
  }
}
