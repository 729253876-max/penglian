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

  public override async claimAwaitingConfirmation(
    taskId: string
  ): Promise<StoredTask | undefined> {
    const task = await super.claimAwaitingConfirmation(taskId);
    if (task) {
      this.savedStatuses.push(task.status);
    }
    return task;
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

class CountingImageProvider implements ImageProvider {
  public calls = 0;

  public async runPreview(): Promise<ProviderRunResult> {
    this.calls += 1;
    return successfulProviderResult();
  }
}

class FixedResultImageProvider implements ImageProvider {
  public constructor(private readonly result: ProviderRunResult) {}

  public async runPreview(): Promise<ProviderRunResult> {
    return this.result;
  }
}

class FirstSaveBarrierRepository extends InMemoryTaskRepository {
  private firstSave = true;
  private releaseFirstSave!: () => void;
  private readonly firstSaveReached = new Promise<void>((resolve) => {
    this.releaseFirstSave = resolve;
  });

  public override async save(task: StoredTask): Promise<void> {
    if (this.firstSave) {
      this.firstSave = false;
      await this.firstSaveReached;
    }
    await super.save(task);
  }

  public release(): void {
    this.releaseFirstSave();
  }
}

function successfulProviderResult(): ProviderRunResult {
  return {
    previewUrl: "https://example.invalid/demo-preview/single-flight.jpg",
    events: [
      providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
      providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction", {
        direction: "NATURAL",
        level: "MODERATE"
      }),
      providerEvent("STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed"),
      providerEvent("QUALITY_CHECK_STARTED", "QUALITY", "quality.started"),
      providerEvent("QUALITY_CHECK_PASSED", "QUALITY", "quality.identity.passed"),
      providerEvent("PREVIEW_READY", "DELIVERY", "preview.ready", {
        watermarked: true,
        downloadable: false
      })
    ]
  };
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

  it("claims confirmation once when two requests arrive concurrently", async () => {
    const repository = new InMemoryTaskRepository();
    const provider = new CountingImageProvider();
    const service = new TaskService(repository, provider);
    const created = await service.create(portraitInput);

    const results = await Promise.allSettled([
      service.confirmAndRunPreview(created.taskId),
      service.confirmAndRunPreview(created.taskId)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: new Error("TASK_CONFIRMATION_CONFLICT") }
    ]);
    expect(provider.calls).toBe(1);
    await expect(service.getEvents(created.taskId, 0)).resolves.toHaveLength(9);
  });

  it("fails before persistence when a provider inserts an invalid success event", async () => {
    const invalidResults: ProviderRunResult[] = [
      {
        previewUrl: "https://example.invalid/demo-preview/malicious.jpg",
        events: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("TASK_FAILED", "DELIVERY", "preview.provider.failed")
        ]
      },
      {
        previewUrl: "https://example.invalid/demo-preview/malicious.jpg",
        events: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PREVIEW_READY", "DELIVERY", "preview.ready")
        ]
      },
      {
        previewUrl: "https://example.invalid/demo-preview/malicious.jpg",
        events: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PARAM_DIRECTION_APPLIED", "QUALITY", "portrait.parameter.direction")
        ]
      },
      {
        previewUrl: "https://example.invalid/demo-preview/malicious.jpg",
        events: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.stage.unapproved.started")
        ]
      },
      {
        previewUrl: "https://example.invalid/demo-preview/malicious.jpg",
        events: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction", {
            direction: "WARM",
            level: "MODERATE"
          }),
          providerEvent("STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed"),
          providerEvent("QUALITY_CHECK_STARTED", "QUALITY", "quality.started"),
          providerEvent("QUALITY_CHECK_PASSED", "QUALITY", "quality.identity.passed"),
          providerEvent("PREVIEW_READY", "DELIVERY", "preview.ready", {
            watermarked: true,
            downloadable: false
          })
        ]
      }
    ];

    for (const result of invalidResults) {
      const service = new TaskService(
        new InMemoryTaskRepository(),
        new FixedResultImageProvider(result)
      );
      const created = await service.create(portraitInput);

      const finished = await service.confirmAndRunPreview(created.taskId);
      const events = await service.getEvents(created.taskId, 0);

      expect(finished).toMatchObject({
        status: "FAILED",
        failureCode: "PREVIEW_PROVIDER_FAILED"
      });
      expect(events.map((event) => event.type)).toEqual([
        "DIAGNOSIS_STARTED",
        "DIAGNOSIS_FINDING",
        "PLAN_READY",
        "TASK_FAILED"
      ]);
    }
  });

  it("isolates the input captured before the first asynchronous save", async () => {
    const repository = new FirstSaveBarrierRepository();
    const service = new TaskService(repository, new MockImageProvider());
    const input = structuredClone(portraitInput);

    const creating = service.create(input);
    input.direction = "WARM";
    input.parameters.naturalness = 5;
    repository.release();
    const created = await creating;

    const events = await service.getEvents(created.taskId, 0);
    expect(events.at(-1)).toMatchObject({
      type: "PLAN_READY",
      payload: { direction: "NATURAL" }
    });
  });

  it("guards repository event sequence and does not leak mutable task or event data", async () => {
    const repository = new InMemoryTaskRepository();
    const storedTask: StoredTask = {
      taskId: "isolation-task",
      status: "REVIEWING",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 0,
      input: structuredClone(portraitInput)
    };
    const firstEvent: EditTraceEvent = {
      ...providerEvent("PLAN_READY", "PLAN", "portrait.plan.natural", { direction: "NATURAL" }),
      eventId: "event-1",
      taskId: storedTask.taskId,
      sequence: 1
    };
    await repository.save(storedTask);
    await repository.appendEvent(firstEvent);

    const found = await repository.find(storedTask.taskId);
    const events = await repository.eventsAfter(storedTask.taskId, 0);
    if (!found || found.input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("stored task must be found");
    }
    found.input.parameters.naturalness = 5;
    events[0]!.payload.direction = "WARM";

    await expect(repository.appendEvent({ ...firstEvent, eventId: "event-duplicate" }))
      .rejects.toThrow("EVENT_SEQUENCE_CONFLICT");
    await expect(repository.appendEvent({ ...firstEvent, eventId: "event-gap", sequence: 3 }))
      .rejects.toThrow("EVENT_SEQUENCE_CONFLICT");
    await expect(repository.find(storedTask.taskId)).resolves.toMatchObject({
      input: { parameters: { naturalness: 80 } }
    });
    await expect(repository.eventsAfter(storedTask.taskId, 0)).resolves.toMatchObject([
      { payload: { direction: "NATURAL" } }
    ]);
  });
});
