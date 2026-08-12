import { describe, expect, it, vi } from "vitest";
import type {
  CreateTaskInput,
  EditTraceEvent
} from "@photo-ai/contracts";
import {
  StageADemoAssetReader,
  TaskService,
  type ImageProvider,
  type ProviderCandidate,
  type StoredTask
} from "../src/application/task-service.js";
import { InMemoryTaskRepository } from "../src/infrastructure/in-memory-task-repository.js";
import { MockImageProvider } from "../src/infrastructure/mock-image-provider.js";
import type {
  PortraitAsset,
  PortraitAssetReader
} from "../src/ports/portrait-asset-reader.js";
import { DeterministicPortraitDiagnosisService } from "../src/application/portrait-diagnosis-service.js";
import { PortraitPlanService } from "../src/application/portrait-plan-service.js";
import {
  DeterministicPortraitQualityGate,
  type PortraitQualityGate,
  type QualityGateResult
} from "../src/application/portrait-quality-gate.js";

const portraitInput: CreateTaskInput = {
  tool: "PORTRAIT_RETOUCH",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL_RESCUE",
  parameters: { naturalness: 85, detailLevel: 35 }
};
const userId = "test-user";

const failedGate: QualityGateResult = {
  passed: false,
  checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"],
  failedChecks: ["IDENTITY"]
};

const passingGate = () => new DeterministicPortraitQualityGate({ passed: true });

class SequenceQualityGate implements PortraitQualityGate {
  public constructor(private readonly results: QualityGateResult[]) {}

  public async evaluate(): Promise<QualityGateResult> {
    const result = this.results.shift();
    if (!result) throw new Error("missing quality fixture");
    return result;
  }
}

const approvedAsset: PortraitAsset = {
  assetId: "approved-portrait-1",
  userId: "user-1",
  uploadSessionId: "upload-1",
  objectKey: "private/approved-portrait-1",
  width: 2400,
  height: 3200,
  qualityWarning: true
};

const approvedPortraitInput: CreateTaskInput = {
  ...portraitInput,
  inputAssetId: approvedAsset.assetId
};

class FixedPortraitAssetReader implements PortraitAssetReader {
  public constructor(private readonly asset: PortraitAsset | undefined) {}

  public async findApprovedNormalized(
    userId: string,
    assetId: string
  ): Promise<PortraitAsset | undefined> {
    return this.asset?.userId === userId && this.asset.assetId === assetId
      ? structuredClone(this.asset)
      : undefined;
  }
}

function buildTaskService(asset: PortraitAsset | undefined) {
  const repository = new RecordingTaskRepository();
  const service = new TaskService(
    repository,
    new MockImageProvider(),
    new FixedPortraitAssetReader(asset),
    undefined,
    new DeterministicPortraitDiagnosisService(),
    new PortraitPlanService(),
    new DeterministicPortraitQualityGate({ passed: true })
  );
  return { service, repository };
}

class RecordingTaskRepository extends InMemoryTaskRepository {
  public readonly savedStatuses: StoredTask["status"][] = [];

  public override async save(task: StoredTask): Promise<void> {
    this.savedStatuses.push(task.status);
    await super.save(task);
  }

  public override async claimAwaitingConfirmation(
    userId: string,
    taskId: string
  ): Promise<StoredTask | undefined> {
    const task = await super.claimAwaitingConfirmation(userId, taskId);
    if (task) {
      this.savedStatuses.push(task.status);
    }
    return task;
  }
}

class ThrowingImageProvider implements ImageProvider {
  public async runPreview(): Promise<ProviderCandidate> {
    throw new Error("provider unavailable");
  }
}

class CountingImageProvider implements ImageProvider {
  public calls = 0;
  public readonly attempts: number[] = [];

  public async runPreview(_input: CreateTaskInput, attempt: 1 | 2): Promise<ProviderCandidate> {
    this.calls += 1;
    this.attempts.push(attempt);
    return successfulProviderResult();
  }
}

class FixedResultImageProvider implements ImageProvider {
  public constructor(private readonly result: ProviderCandidate) {}

  public async runPreview(): Promise<ProviderCandidate> {
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

function successfulProviderResult(): ProviderCandidate {
  return {
    candidateAssetId: "candidate-1",
    watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
    receipts: [
      providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started", { stage: "LOCAL_LIGHT_AND_SKIN" }),
      providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction", {
        direction: "NATURAL_RESCUE",
        level: "MODERATE"
      }),
      providerEvent("STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed", { stage: "LOCAL_LIGHT_AND_SKIN" })
    ]
  };
}

function providerResultWithMalformedFinalEvent(
  mutate: (event: Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">) => void
): ProviderCandidate {
  const result = successfulProviderResult();
  const finalEvent = result.receipts.at(-1);
  if (!finalEvent) {
    throw new Error("provider result must include a preview event");
  }
  mutate(finalEvent);
  return result;
}

function providerEvent(
  type: EditTraceEvent["type"],
  phase: EditTraceEvent["phase"],
  copyKey: EditTraceEvent["copyKey"],
  payload: EditTraceEvent["payload"] = {}
): Omit<EditTraceEvent, "eventId" | "taskId" | "sequence"> {
  return {
    type,
    phase,
    occurredAt: "2026-07-26T00:00:00.000Z",
    visibility: "PREVIEW",
    evidenceSource: type === "RETRY_STARTED"
      ? "SYSTEM_CHECK"
      : type.startsWith("QUALITY_") || type === "PREVIEW_READY"
        ? "QUALITY_GATE"
        : "PROVIDER_RECEIPT",
    copyKey,
    payload
  };
}

class RecordingDirectionImageProvider implements ImageProvider {
  public input: CreateTaskInput | undefined;

  public constructor(
    private readonly direction: "NATURAL_RESCUE" | "CLEAR_RESCUE"
  ) {}

  public async runPreview(input: CreateTaskInput): Promise<ProviderCandidate> {
    this.input = structuredClone(input);
    return {
      candidateAssetId: "candidate-direction",
      watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
      receipts: [
        providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started", { stage: "LOCAL_LIGHT_AND_SKIN" }),
        providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction", {
          direction: this.direction,
          level: "MODERATE"
        }),
        providerEvent("STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed", { stage: "LOCAL_LIGHT_AND_SKIN" })
      ]
    };
  }
}

const creationEventTypes: EditTraceEvent["type"][] = [
  "ASSET_APPROVED",
  "DIAGNOSIS_STARTED",
  "DIAGNOSIS_FINDING",
  "DIAGNOSIS_FINDING",
  "PROTECTION_RECORDED",
  "PLAN_READY",
  "PLAN_READY",
  "PLAN_SELECTED"
];

describe("TaskService", () => {
  it("rejects a provider receipt that claims quality or delivery authority", async () => {
    const result = successfulProviderResult();
    result.receipts.push(
      providerEvent("QUALITY_CHECK_PASSED", "QUALITY", "quality.fidelity.passed", {
        checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"]
      })
    );
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new FixedResultImageProvider(result),
      new StageADemoAssetReader(),
      undefined,
      undefined,
      undefined,
      passingGate()
    );
    const created = await service.create(userId, portraitInput);

    const finished = await service.confirmAndRunPreview(userId, created.taskId);

    expect(finished).toMatchObject({
      status: "FAILED",
      failureCode: "PREVIEW_PROVIDER_FAILED",
      noCharge: true
    });
  });

  it("retries exactly once and never exposes a twice-rejected candidate", async () => {
    const provider = new CountingImageProvider();
    const service = new TaskService(
      new InMemoryTaskRepository(),
      provider,
      new StageADemoAssetReader(),
      undefined,
      undefined,
      undefined,
      new SequenceQualityGate([failedGate, failedGate])
    );
    const created = await service.create(userId, portraitInput);

    const finished = await service.confirmAndRunPreview(userId, created.taskId);

    expect(provider.attempts).toEqual([1, 2]);
    expect(finished).toMatchObject({
      status: "FAILED",
      failureCode: "FIDELITY_GATE_FAILED",
      noCharge: true
    });
    expect(finished.previewUrl).toBeUndefined();
  });

  it("rejects a portrait task before persistence when the asset is not approved", async () => {
    const { service, repository } = buildTaskService(undefined);

    await expect(service.create("user-1", approvedPortraitInput)).rejects.toThrow(
      "ASSET_NOT_APPROVED"
    );
    expect(repository.savedStatuses).toEqual([]);
  });

  it("rejects a cross-user portrait asset before persistence", async () => {
    const { service, repository } = buildTaskService(approvedAsset);

    await expect(service.create("user-2", approvedPortraitInput)).rejects.toThrow(
      "ASSET_NOT_APPROVED"
    );
    expect(repository.savedStatuses).toEqual([]);
  });

  it("returns diagnosis and records both plans for an approved asset", async () => {
    const { service } = buildTaskService(approvedAsset);

    const created = await service.create("user-1", approvedPortraitInput);
    const events = await service.getEvents("user-1", created.taskId, 0);

    expect(created).toMatchObject({
      status: "AWAITING_CONFIRMATION",
      diagnosis: {
        findings: ["LIGHT_NOISE", "LIGHT_BLUR"],
        protections: expect.arrayContaining(["IDENTITY", "COMPOSITION"])
      },
      selectedDirection: "NATURAL_RESCUE"
    });
    expect(events.map((event) => event.type)).toEqual([
      "ASSET_APPROVED",
      "DIAGNOSIS_STARTED",
      "DIAGNOSIS_FINDING",
      "DIAGNOSIS_FINDING",
      "PROTECTION_RECORDED",
      "PLAN_READY",
      "PLAN_READY",
      "PLAN_SELECTED"
    ]);
    expect(events.filter((event) => event.type === "PLAN_READY").map((event) => event.payload))
      .toEqual([
        { direction: "NATURAL_RESCUE" },
        { direction: "CLEAR_RESCUE" }
      ]);
  });

  it.each([
    ["NATURAL_RESCUE" as const, 85, 35],
    ["CLEAR_RESCUE" as const, 75, 60]
  ])("normalizes a real %s request and keeps selection, events, and provider input aligned", async (
    direction,
    naturalness,
    detailLevel
  ) => {
    const repository = new InMemoryTaskRepository();
    const provider = new RecordingDirectionImageProvider(direction);
    const service = new TaskService(
      repository,
      provider,
      new FixedPortraitAssetReader(approvedAsset)
    );
    const input: CreateTaskInput = {
      ...approvedPortraitInput,
      direction,
      parameters: { naturalness: 3, detailLevel: 99 }
    };

    const created = await service.create("user-1", input);
    const creationEvents = await service.getEvents("user-1", created.taskId, 0);

    expect(created.selectedDirection).toBe(direction);
    expect(creationEvents.filter((event) => event.type === "PLAN_READY")).toMatchObject([
      { copyKey: "portrait.plan.natural", payload: { direction: "NATURAL_RESCUE" } },
      { copyKey: "portrait.plan.clear", payload: { direction: "CLEAR_RESCUE" } }
    ]);
    expect(creationEvents.at(-1)).toMatchObject({
      type: "PLAN_SELECTED",
      payload: { direction }
    });

    await service.confirmAndRunPreview("user-1", created.taskId);
    expect(provider.input).toEqual({
      ...approvedPortraitInput,
      direction,
      parameters: { naturalness, detailLevel }
    });
  });

  it("emits truthful, continuously sequenced events and produces a watermarked preview", async () => {
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new MockImageProvider(),
      new StageADemoAssetReader(),
      undefined,
      undefined,
      undefined,
      passingGate()
    );

    const created = await service.create(userId, portraitInput);
    expect(created.status).toBe("AWAITING_CONFIRMATION");

    const finished = await service.confirmAndRunPreview(userId, created.taskId);
    expect(finished).toMatchObject({
      status: "SUCCEEDED",
      previewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg"
    });

    const events = await service.getEvents(userId, created.taskId, 0);
    expect(events.map((event) => event.type)).toEqual([
      ...creationEventTypes,
      "STAGE_STARTED",
      "PARAM_DIRECTION_APPLIED",
      "STAGE_COMPLETED",
      "QUALITY_CHECK_STARTED",
      "QUALITY_CHECK_PASSED",
      "PREVIEW_READY"
    ]);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1)
    );
    expect(events.at(-1)?.payload).toEqual({ watermarked: true, downloadable: false });
  });

  it("persists only legal states on the documented preview path", async () => {
    const repository = new RecordingTaskRepository();
    const service = new TaskService(
      repository,
      new MockImageProvider(),
      new StageADemoAssetReader(),
      undefined,
      undefined,
      undefined,
      passingGate()
    );

    const created = await service.create(userId, portraitInput);
    await service.confirmAndRunPreview(userId, created.taskId);

    expect(repository.savedStatuses).toEqual([
      "REVIEWING",
      "REVIEWING",
      "DIAGNOSING",
      "DIAGNOSING",
      "DIAGNOSING",
      "DIAGNOSING",
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
    const service = new TaskService(
      repository,
      new MockImageProvider(),
      new StageADemoAssetReader()
    );

    await expect(service.create(userId, input)).rejects.toThrow("STAGE_A_UNSUPPORTED_TOOL");

    expect(save).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unknown asset",
      {
        ...portraitInput,
        inputAssetId: "completely-unknown-asset"
      }
    ],
    [
      "an unsupported direction",
      {
        ...portraitInput,
        direction: "CLEAR_RESCUE" as const
      }
    ],
    [
      "parameters that are not registered for the demo",
      {
        ...portraitInput,
        parameters: {
          ...portraitInput.parameters,
          naturalness: 12
        }
      }
    ]
  ])("rejects %s before saving a task or writing a diagnosis", async (_name, input) => {
    const repository = new InMemoryTaskRepository();
    const save = vi.spyOn(repository, "save");
    const appendEvent = vi.spyOn(repository, "appendEvent");
    const service = new TaskService(
      repository,
      new MockImageProvider(),
      new StageADemoAssetReader()
    );

    await expect(service.create(userId, input)).rejects.toThrow(
      "STAGE_A_UNSUPPORTED_DEMO_INPUT"
    );

    expect(save).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it("ties diagnosis, plan, preview, and event time to the registered demo profile and injected clock", async () => {
    const occurredAt = "2032-03-04T05:06:07.000Z";
    const clock = {
      now: () => new Date(occurredAt)
    };
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new MockImageProvider(clock),
      new StageADemoAssetReader(),
      clock,
      undefined,
      undefined,
      passingGate()
    );

    const created = await service.create(userId, portraitInput);
    const finished = await service.confirmAndRunPreview(userId, created.taskId);
    const events = await service.getEvents(userId, created.taskId, 0);

    expect(events.slice(0, 8)).toMatchObject([
      { type: "ASSET_APPROVED", payload: { metadataRemoved: true } },
      {
        type: "DIAGNOSIS_STARTED",
        copyKey: "portrait.diagnosis.started",
        payload: {}
      },
      {
        type: "DIAGNOSIS_FINDING",
        copyKey: "portrait.diagnosis.light",
        payload: { finding: "LIGHT_NOISE" }
      },
      { type: "DIAGNOSIS_FINDING", payload: { finding: "LIGHT_BLUR" } },
      { type: "PROTECTION_RECORDED" },
      {
        type: "PLAN_READY",
        copyKey: "portrait.plan.natural",
        payload: { direction: "NATURAL_RESCUE" }
      },
      { type: "PLAN_READY", payload: { direction: "CLEAR_RESCUE" } },
      { type: "PLAN_SELECTED", payload: { direction: "NATURAL_RESCUE" } }
    ]);
    expect(events.every((event) => event.occurredAt === occurredAt)).toBe(true);
    expect(finished.previewUrl).toBe(
      "https://example.invalid/demo-preview/portrait-natural.jpg"
    );
  });

  it("records a truthful failure when the provider cannot produce a preview", async () => {
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new ThrowingImageProvider(),
      new StageADemoAssetReader()
    );
    const created = await service.create(userId, portraitInput);

    const finished = await service.confirmAndRunPreview(userId, created.taskId);

    expect(finished).toMatchObject({
      status: "FAILED",
      failureCode: "PREVIEW_PROVIDER_FAILED"
    });
    await expect(service.getEvents(userId, created.taskId, 0)).resolves.toMatchObject([
      ...creationEventTypes.map((type) => ({ type })),
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
    const gate = new SequenceQualityGate([
      failedGate,
      {
        passed: true,
        checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"]
      }
    ]);
    const service = new TaskService(
      repository,
      new CountingImageProvider(),
      new StageADemoAssetReader(),
      undefined,
      undefined,
      undefined,
      gate
    );
    const created = await service.create(userId, portraitInput);

    const finished = await service.confirmAndRunPreview(userId, created.taskId);
    const events = await service.getEvents(userId, created.taskId, 8);

    expect(finished.status).toBe("SUCCEEDED");
    expect(events.map((event) => event.type)).toEqual([
      "STAGE_STARTED",
      "PARAM_DIRECTION_APPLIED",
      "STAGE_COMPLETED",
      "QUALITY_CHECK_STARTED",
      "QUALITY_CHECK_FAILED",
      "RETRY_STARTED",
      "STAGE_STARTED",
      "PARAM_DIRECTION_APPLIED",
      "STAGE_COMPLETED",
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
    const service = new TaskService(
      repository,
      provider,
      new StageADemoAssetReader(),
      undefined,
      undefined,
      undefined,
      passingGate()
    );
    const created = await service.create(userId, portraitInput);

    const results = await Promise.allSettled([
      service.confirmAndRunPreview(userId, created.taskId),
      service.confirmAndRunPreview(userId, created.taskId)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: new Error("TASK_CONFIRMATION_CONFLICT") }
    ]);
    expect(provider.calls).toBe(1);
    await expect(service.getEvents(userId, created.taskId, 0)).resolves.toHaveLength(14);
  });

  it("fails before persistence when a provider inserts an invalid success event", async () => {
    const invalidResults: ProviderCandidate[] = [
      {
        ...successfulProviderResult(),
        watermarkedPreviewUrl: "https://example.invalid/demo-preview/unregistered.jpg"
      },
      {
        candidateAssetId: "malicious-1",
        watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
        receipts: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("TASK_FAILED", "DELIVERY", "preview.provider.failed")
        ]
      },
      {
        candidateAssetId: "malicious-2",
        watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
        receipts: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PREVIEW_READY", "DELIVERY", "preview.ready")
        ]
      },
      {
        candidateAssetId: "malicious-3",
        watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
        receipts: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PARAM_DIRECTION_APPLIED", "QUALITY", "portrait.parameter.direction")
        ]
      },
      {
        candidateAssetId: "malicious-4",
        watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
        receipts: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent(
            "PARAM_DIRECTION_APPLIED",
            "RETOUCH",
            "portrait.stage.unapproved.started" as EditTraceEvent["copyKey"]
          )
        ]
      },
      {
        candidateAssetId: "malicious-5",
        watermarkedPreviewUrl: "https://example.invalid/demo-preview/portrait-natural.jpg",
        receipts: [
          providerEvent("STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"),
          providerEvent("PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction", {
            direction: "CLEAR_RESCUE",
            level: "MODERATE"
          }),
          providerEvent("STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed"),
          providerEvent("QUALITY_CHECK_STARTED", "QUALITY", "quality.started"),
          providerEvent("QUALITY_CHECK_PASSED", "QUALITY", "quality.fidelity.passed", {
            checks: ["FACE_COUNT", "IDENTITY", "STRUCTURE", "NON_TARGET_REGION", "ARTIFACTS"]
          }),
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
        new FixedResultImageProvider(result),
        new StageADemoAssetReader()
      );
      const created = await service.create(userId, portraitInput);

      const finished = await service.confirmAndRunPreview(userId, created.taskId);
      const events = await service.getEvents(userId, created.taskId, 0);

      expect(finished).toMatchObject({
        status: "FAILED",
        failureCode: "PREVIEW_PROVIDER_FAILED"
      });
      expect(events.map((event) => event.type)).toEqual([
        ...creationEventTypes,
        "TASK_FAILED"
      ]);
    }
  });

  it.each([
    [
      "a hidden reasoning payload field",
      providerResultWithMalformedFinalEvent((event) => {
        (event.payload as unknown as Record<string, unknown>).hiddenReasoning =
          "private provider reasoning";
      })
    ],
    [
      "an invalid timestamp",
      providerResultWithMalformedFinalEvent((event) => {
        event.occurredAt = "not-an-rfc3339-timestamp";
      })
    ]
  ])("does not persist a valid provider prefix before rejecting %s", async (_name, result) => {
    const service = new TaskService(
      new InMemoryTaskRepository(),
      new FixedResultImageProvider(result),
      new StageADemoAssetReader()
    );
    const created = await service.create(userId, portraitInput);

    const finished = await service.confirmAndRunPreview(userId, created.taskId);
    const events = await service.getEvents(userId, created.taskId, 0);

    expect(finished).toMatchObject({
      status: "FAILED",
      failureCode: "PREVIEW_PROVIDER_FAILED"
    });
    expect(events.map((event) => event.type)).toEqual([
      ...creationEventTypes,
      "TASK_FAILED"
    ]);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 9 }, (_, index) => index + 1)
    );
  });

  it.each([
    "accessToken",
    "authorization",
    "signedImageUrl",
    "providerModel",
    "moderationResult",
    "providerRawPayload",
    "futureUnknownField"
  ])("rejects a provider batch containing %s before persisting any provider event", async (key) => {
    const result = successfulProviderResult();
    const middleEvent = result.receipts[2];
    if (!middleEvent) {
      throw new Error("provider result must include a middle event");
    }
    (middleEvent.payload as unknown as Record<string, unknown>)[key] =
      key === "signedImageUrl"
        ? "https://secret.invalid/signed-preview"
        : "must-not-ship";

    const service = new TaskService(
      new InMemoryTaskRepository(),
      new FixedResultImageProvider(result),
      new StageADemoAssetReader()
    );
    const created = await service.create(userId, portraitInput);

    const finished = await service.confirmAndRunPreview(userId, created.taskId);
    const events = await service.getEvents(userId, created.taskId, 0);

    expect(finished).toMatchObject({
      status: "FAILED",
      failureCode: "PREVIEW_PROVIDER_FAILED"
    });
    expect(events.map((event) => event.type)).toEqual([
      ...creationEventTypes,
      "TASK_FAILED"
    ]);
    expect(events.some((event) =>
      Object.hasOwn(event.payload, key)
    )).toBe(false);
  });

  it("isolates the input captured before the first asynchronous save", async () => {
    const repository = new FirstSaveBarrierRepository();
    const service = new TaskService(
      repository,
      new MockImageProvider(),
      new StageADemoAssetReader()
    );
    const input = structuredClone(portraitInput);

    const creating = service.create(userId, input);
    input.direction = "CLEAR_RESCUE";
    input.parameters.naturalness = 5;
    repository.release();
    const created = await creating;

    const events = await service.getEvents(userId, created.taskId, 0);
    expect(events.at(-1)).toMatchObject({
      type: "PLAN_SELECTED",
      payload: { direction: "NATURAL_RESCUE" }
    });
  });

  it("guards repository event sequence and does not leak mutable task or event data", async () => {
    const repository = new InMemoryTaskRepository();
    const storedTask: StoredTask = {
      taskId: "isolation-task",
      userId,
      status: "REVIEWING",
      tool: "PORTRAIT_RETOUCH",
      lastSequence: 0,
      input: structuredClone(portraitInput)
    };
    const firstEvent: EditTraceEvent = {
      eventId: "event-1",
      taskId: storedTask.taskId,
      sequence: 1,
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: "2026-07-26T00:00:00.000Z",
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural",
      payload: { direction: "NATURAL_RESCUE" }
    };
    await repository.save(storedTask);
    await repository.appendEvent(firstEvent);

    const found = await repository.findForUser(userId, storedTask.taskId);
    const events = await repository.eventsAfter(userId, storedTask.taskId, 0);
    if (!found || found.input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("stored task must be found");
    }
    found.input.parameters.naturalness = 5;
    (events[0]!.payload as unknown as Record<string, unknown>).direction = "WARM";

    await expect(repository.appendEvent({ ...firstEvent, eventId: "event-duplicate" }))
      .rejects.toThrow("EVENT_SEQUENCE_CONFLICT");
    await expect(repository.appendEvent({ ...firstEvent, eventId: "event-gap", sequence: 3 }))
      .rejects.toThrow("EVENT_SEQUENCE_CONFLICT");
    await expect(repository.findForUser(userId, storedTask.taskId)).resolves.toMatchObject({
      input: { parameters: { naturalness: 85 } }
    });
    await expect(repository.eventsAfter(userId, storedTask.taskId, 0)).resolves.toMatchObject([
      { payload: { direction: "NATURAL_RESCUE" } }
    ]);
  });
});
