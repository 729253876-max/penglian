import { describe, expect, it, vi } from "vitest";
import type {
  CreateTaskInput,
  EditTraceEvent
} from "@photo-ai/contracts";
import {
  TaskService,
  type ImageProvider,
  type ProviderRunResult,
  type StoredTask
} from "../src/application/task-service.js";
import { InMemoryTaskRepository } from "../src/infrastructure/in-memory-task-repository.js";
import { MockImageProvider } from "../src/infrastructure/mock-image-provider.js";

const portraitInput: CreateTaskInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL",
  parameters: { brightness: 0, warmth: 0, naturalness: 80 }
};

class RecordingTaskRepository extends InMemoryTaskRepository {
  public readonly savedStatuses: StoredTask["status"][] = [];

  public override async save(task: StoredTask): Promise<void> {
    this.savedStatuses.push(task.status);
    await super.save(task);
  }
}

class ThrowingImageProvider implements ImageProvider {
  public async runPreview(): Promise<ProviderRunResult> {
    throw new Error("provider unavailable");
  }
}

class RetryingImageProvider implements ImageProvider {
  public async runPreview(): Promise<ProviderRunResult> {
    return {
      previewUrl: "https://example.invalid/demo-preview/retried.jpg",
      events: [
        providerEvent("QUALITY_CHECK_STARTED", "QUALITY", "quality.started"),
        providerEvent("QUALITY_CHECK_FAILED", "QUALITY", "quality.identity.failed"),
        providerEvent("RETRY_STARTED", "RETOUCH", "portrait.retry.started", { attempt: 2 }),
        providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retry.started"),
        providerEvent("QUALITY_CHECK_STARTED", "QUALITY", "quality.retry.started"),
        providerEvent("QUALITY_CHECK_PASSED", "QUALITY", "quality.identity.passed"),
        providerEvent("PREVIEW_READY", "DELIVERY", "preview.ready", {
          watermarked: true,
          downloadable: false
        })
      ]
    };
  }
}

function providerEvent(
  type: EditTraceEvent["type"],
  phase: string,
  copyKey: string,
  payload: EditTraceEvent["payload"] = {}
): Omit<EditTraceEvent, "eventId" | "taskId" | "sequence"> {
  return {
    type,
    phase,
    occurredAt: "2026-07-26T00:00:00.000Z",
    visibility: "PREVIEW",
    copyKey,
    payload
  };
}

describe("TaskService", () => {
  it("emits truthful, continuously sequenced events and produces a watermarked preview", async () => {
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new MockImageProvider()
    );

    const created = await service.create(portraitInput);
    expect(created.status).toBe("AWAITING_CONFIRMATION");

    const finished = await service.confirmAndRunPreview(created.taskId);
    expect(finished).toMatchObject({
      status: "SUCCEEDED",
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
    });

    const events = await service.getEvents(created.taskId, 0);
    expect(events.map((event) => event.type)).toEqual([
      "DIAGNOSIS_STARTED",
      "DIAGNOSIS_FINDING",
      "PLAN_READY",
      "STAGE_STARTED",
      "PARAM_DIRECTION_APPLIED",
      "STAGE_COMPLETED",
      "QUALITY_CHECK_STARTED",
      "QUALITY_CHECK_PASSED",
      "PREVIEW_READY"
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.at(-1)?.payload).toEqual({ watermarked: true, downloadable: false });
  });

  it("persists only legal states on the documented preview path", async () => {
    const repository = new RecordingTaskRepository();
    const service = new TaskService(repository, new MockImageProvider());

    const created = await service.create(portraitInput);
    await service.confirmAndRunPreview(created.taskId);

    expect(repository.savedStatuses).toEqual([
      "REVIEWING",
      "DIAGNOSING",
      "DIAGNOSING",
      "DIAGNOSING",
      "DIAGNOSING",
      "AWAITING_CONFIRMATION",
      "QUEUED",
      "PROCESSING",
      "PROCESSING",
      "PROCESSING",
      "PROCESSING",
      "QUALITY_CHECKING",
      "QUALITY_CHECKING",
      "QUALITY_CHECKING",
      "QUALITY_CHECKING",
      "SUCCEEDED"
    ]);
  });

  it.each([
    {
      tool: "QUALITY_ENHANCE" as const,
      inputAssetId: "demo-quality-001",
      direction: "QUALITY_FIRST" as const,
      parameters: { outputTier: "STANDARD", detailPreservation: 80 }
    },
    {
      tool: "OBJECT_REMOVAL" as const,
      inputAssetId: "demo-object-001",
      direction: "REMOVE_CONFIRMED_TARGET" as const,
      parameters: { confirmedMaskAssetId: "mask-001" }
    },
    {
      tool: "OLD_PHOTO_RESTORE" as const,
      inputAssetId: "demo-old-photo-001",
      direction: "FAITHFUL_RESTORE" as const,
      parameters: { colorizationRequested: true, colorizationConfirmed: true }
    }
  ])("rejects $tool before saving a task or writing portrait events", async (input) => {
    const repository = new InMemoryTaskRepository();
    const save = vi.spyOn(repository, "save");
    const appendEvent = vi.spyOn(repository, "appendEvent");
    const service = new TaskService(repository, new MockImageProvider());

    await expect(service.create(input)).rejects.toThrow("STAGE_A_UNSUPPORTED_TOOL");

    expect(save).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("records a truthful failure when the provider cannot produce a preview", async () => {
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new ThrowingImageProvider()
    );
    const created = await service.create(portraitInput);

    const finished = await service.confirmAndRunPreview(created.taskId);

    expect(finished).toMatchObject({
      status: "FAILED",
      failureCode: "PREVIEW_PROVIDER_FAILED"
    });
    await expect(service.getEvents(created.taskId, 0)).resolves.toMatchObject([
      { type: "DIAGNOSIS_STARTED" },
      { type: "DIAGNOSIS_FINDING" },
      { type: "PLAN_READY" },
      {
        type: "TASK_FAILED",
        phase: "DELIVERY",
        copyKey: "preview.provider.failed",
        payload: { code: "PREVIEW_PROVIDER_FAILED" }
      }
    ]);
  });

  it("records an actual quality retry and returns to processing before succeeding", async () => {
    const repository = new RecordingTaskRepository();
    const service = new TaskService(repository, new RetryingImageProvider());
    const created = await service.create(portraitInput);

    const finished = await service.confirmAndRunPreview(created.taskId);
    const events = await service.getEvents(created.taskId, 3);

    expect(finished.status).toBe("SUCCEEDED");
    expect(events.map((event) => event.type)).toEqual([
      "QUALITY_CHECK_STARTED",
      "QUALITY_CHECK_FAILED",
      "RETRY_STARTED",
      "STAGE_STARTED",
      "QUALITY_CHECK_STARTED",
      "QUALITY_CHECK_PASSED",
      "PREVIEW_READY"
    ]);
    expect(repository.savedStatuses).toContain("QUALITY_CHECKING");
    expect(repository.savedStatuses).toContain("PROCESSING");
  });
});
