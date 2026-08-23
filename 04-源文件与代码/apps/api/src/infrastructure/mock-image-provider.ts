import type {
  CreateTaskInput,
  EditTraceEvent
} from "@photo-ai/contracts";
import type {
  ImageProvider,
  ProviderCandidate
} from "../application/task-service.js";
import {
  occurredAt,
  systemClock,
  type Clock
} from "../domain/clock.js";
import { requireStageADemoProfile } from "../domain/stage-a-demo-catalog.js";

type ProviderEvent = Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">;

export class MockImageProvider implements ImageProvider {
  public constructor(private readonly clock: Clock = systemClock) {}

  public async runPreview(input: CreateTaskInput): Promise<ProviderCandidate> {
    if (input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("MOCK_PROVIDER_UNSUPPORTED_TOOL");
    }
    const demoProfile = requireStageADemoProfile(input);
    const publicEvent = (
      event: Omit<ProviderEvent, "occurredAt">
    ): ProviderEvent => ({
      ...event,
      occurredAt: occurredAt(this.clock)
    });

    return {
      candidateAssetId: "demo-candidate-portrait-natural",
      watermarkedPreviewUrl: demoProfile.preview.url,
      receipts: [
        publicEvent({
          type: "STAGE_STARTED",
          phase: "RETOUCH",
          visibility: "PREVIEW",
          evidenceSource: "PROVIDER_RECEIPT",
          copyKey: "portrait.stage.retouch.started",
          payload: { stage: "LOCAL_LIGHT_AND_SKIN" }
        }),
        publicEvent({
          type: "PARAM_DIRECTION_APPLIED",
          phase: "RETOUCH",
          visibility: "PREVIEW",
          evidenceSource: "PROVIDER_RECEIPT",
          copyKey: "portrait.parameter.direction",
          payload: { direction: demoProfile.direction, level: "MODERATE" }
        }),
        publicEvent({
          type: "STAGE_COMPLETED",
          phase: "RETOUCH",
          visibility: "PREVIEW",
          evidenceSource: "PROVIDER_RECEIPT",
          copyKey: "portrait.stage.retouch.completed",
          payload: { stage: "LOCAL_LIGHT_AND_SKIN" }
        })
      ]
    };
  }
}
