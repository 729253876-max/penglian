import { randomUUID } from "node:crypto";
import type {
  CreateTaskInput,
  EditTraceEvent,
  TaskSnapshot
} from "@photo-ai/contracts";
import { sanitizeEditTraceEvent } from "../domain/edit-trace-policy.js";
import {
  occurredAt,
  systemClock,
  type Clock
} from "../domain/clock.js";
import {
  requireStageADemoProfile,
  type PortraitTaskInput
} from "../domain/stage-a-demo-catalog.js";
import { transition } from "../domain/task-machine.js";
import type {
  PortraitAsset,
  PortraitAssetReader
} from "../ports/portrait-asset-reader.js";
import {
  DeterministicPortraitDiagnosisService,
  type PortraitDiagnosisService
} from "./portrait-diagnosis-service.js";
import { PortraitPlanService } from "./portrait-plan-service.js";

export interface StoredTask extends TaskSnapshot {
  userId: string;
  input: CreateTaskInput;
}

export interface TaskRepository {
  save(task: StoredTask): Promise<void>;
  findForUser(userId: string, taskId: string): Promise<StoredTask | undefined>;
  claimAwaitingConfirmation(
    userId: string,
    taskId: string
  ): Promise<StoredTask | undefined>;
  appendEvent(event: EditTraceEvent): Promise<void>;
  eventsAfter(
    userId: string,
    taskId: string,
    sequence: number
  ): Promise<EditTraceEvent[]>;
}

export interface ProviderRunResult {
  previewUrl: string;
  events: Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">[];
}

export interface ImageProvider {
  runPreview(input: CreateTaskInput): Promise<ProviderRunResult>;
}

export class StageADemoAssetReader implements PortraitAssetReader {
  public async findApprovedNormalized(
    userId: string,
    assetId: string
  ): Promise<PortraitAsset | undefined> {
    if (assetId !== "demo-portrait-001") {
      return undefined;
    }
    return {
      assetId,
      userId,
      uploadSessionId: "stage-a-demo-upload",
      objectKey: "stage-a-demo/portrait-natural",
      width: 2400,
      height: 3200,
      qualityWarning: true
    };
  }
}

type ProviderEvent = Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">;

type ProviderEventRule = readonly [
  ProviderEvent["type"],
  string,
  string
];

const permittedProviderSequences: readonly (readonly ProviderEventRule[])[] = [
  [
    ["STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"],
    ["PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction"],
    ["STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed"],
    ["QUALITY_CHECK_STARTED", "QUALITY", "quality.started"],
    ["QUALITY_CHECK_PASSED", "QUALITY", "quality.fidelity.passed"],
    ["PREVIEW_READY", "DELIVERY", "preview.ready"]
  ],
  [
    ["QUALITY_CHECK_STARTED", "QUALITY", "quality.started"],
    ["QUALITY_CHECK_FAILED", "QUALITY", "quality.fidelity.failed"],
    ["RETRY_STARTED", "RETOUCH", "portrait.retry.started"],
    ["STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"],
    ["QUALITY_CHECK_STARTED", "QUALITY", "quality.started"],
    ["QUALITY_CHECK_PASSED", "QUALITY", "quality.fidelity.passed"],
    ["PREVIEW_READY", "DELIVERY", "preview.ready"]
  ]
];

export class TaskService {
  public constructor(
    private readonly repository: TaskRepository,
    private readonly provider: ImageProvider,
    private readonly assetReader: PortraitAssetReader,
    private readonly clock: Clock = systemClock,
    private readonly diagnosisService: PortraitDiagnosisService =
      new DeterministicPortraitDiagnosisService(),
    private readonly planService: PortraitPlanService = new PortraitPlanService()
  ) {}

  public async create(
    userId: string,
    input: CreateTaskInput
  ): Promise<TaskSnapshot> {
    if (input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("STAGE_A_UNSUPPORTED_TOOL");
    }

    const capturedInput = structuredClone(input);
    if (this.assetReader instanceof StageADemoAssetReader) {
      requireStageADemoProfile(capturedInput);
    }
    const asset = await this.assetReader.findApprovedNormalized(
      userId,
      capturedInput.inputAssetId
    );
    if (!asset) {
      throw new Error("ASSET_NOT_APPROVED");
    }
    const diagnosis = await this.diagnosisService.diagnose(asset);
    const naturalPlan = this.planService.plan(diagnosis, "NATURAL_RESCUE");
    const clearPlan = this.planService.plan(diagnosis, "CLEAR_RESCUE");

    const task: StoredTask = {
      taskId: randomUUID(),
      userId,
      status: "REVIEWING",
      tool: capturedInput.tool,
      lastSequence: 0,
      input: capturedInput,
      diagnosis: structuredClone(diagnosis),
      selectedDirection: "NATURAL_RESCUE"
    };
    await this.repository.save(task);

    await this.append(task, {
      type: "ASSET_APPROVED",
      phase: "UPLOAD",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "upload.asset.approved",
      payload: { metadataRemoved: true }
    });

    task.status = transition(task.status, "DIAGNOSING");
    await this.repository.save(task);
    await this.append(task, {
      type: "DIAGNOSIS_STARTED",
      phase: "DIAGNOSIS",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.diagnosis.started",
      payload: {}
    });
    for (const finding of diagnosis.findings) {
      await this.append(task, {
        type: "DIAGNOSIS_FINDING",
        phase: "DIAGNOSIS",
        occurredAt: occurredAt(this.clock),
        visibility: "PREVIEW",
        evidenceSource: "SYSTEM_CHECK",
        copyKey: "portrait.diagnosis.light",
        payload: { finding }
      });
    }
    await this.append(task, {
      type: "PROTECTION_RECORDED",
      phase: "DIAGNOSIS",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.protection.recorded",
      payload: { protections: diagnosis.protections }
    });
    await this.append(task, {
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural",
      payload: { direction: naturalPlan.direction }
    });
    await this.append(task, {
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "SYSTEM_CHECK",
      copyKey: "portrait.plan.natural",
      payload: { direction: clearPlan.direction }
    });
    await this.append(task, {
      type: "PLAN_SELECTED",
      phase: "PLAN",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "USER_SELECTION",
      copyKey: "portrait.plan.selected",
      payload: { direction: naturalPlan.direction }
    });
    task.status = transition(task.status, "AWAITING_CONFIRMATION");
    await this.repository.save(task);
    return this.snapshot(task);
  }

  public async confirmAndRunPreview(
    userId: string,
    taskId: string
  ): Promise<TaskSnapshot> {
    await this.requireTask(userId, taskId);
    const task = await this.repository.claimAwaitingConfirmation(userId, taskId);
    if (!task) {
      throw new Error("TASK_CONFIRMATION_CONFLICT");
    }
    task.status = transition(task.status, "PROCESSING");
    await this.repository.save(task);

    try {
      const result = await this.provider.runPreview(structuredClone(task.input));
      this.assertPermittedProviderResult(result, task.input);
      const events = this.sanitizeProviderEventBatch(task, result.events);
      for (const event of events) {
        await this.transitionForEvent(task, event);
        await this.appendSanitized(task, event);
      }
      task.status = transition(task.status, "SUCCEEDED");
      task.previewUrl = result.previewUrl;
      await this.repository.save(task);
    } catch {
      task.status = transition(task.status, "FAILED");
      const failureCode = "PREVIEW_PROVIDER_FAILED" as const;
      task.failureCode = failureCode;
      await this.append(task, {
        type: "TASK_FAILED",
        phase: "DELIVERY",
        occurredAt: occurredAt(this.clock),
        visibility: "PREVIEW",
        evidenceSource: "SYSTEM_CHECK",
        copyKey: "preview.provider.failed",
        payload: { code: failureCode }
      });
      await this.repository.save(task);
    }

    return this.snapshot(task);
  }

  public async get(userId: string, taskId: string): Promise<TaskSnapshot> {
    return this.snapshot(await this.requireTask(userId, taskId));
  }

  public async getEvents(
    userId: string,
    taskId: string,
    afterSequence: number
  ): Promise<EditTraceEvent[]> {
    await this.requireTask(userId, taskId);
    return this.repository.eventsAfter(userId, taskId, afterSequence);
  }

  private async transitionForEvent(
    task: StoredTask,
    event: ProviderEvent
  ): Promise<void> {
    if (event.type === "QUALITY_CHECK_STARTED") {
      task.status = transition(task.status, "QUALITY_CHECKING");
      await this.repository.save(task);
    }

    if (event.type === "RETRY_STARTED") {
      task.status = transition(task.status, "PROCESSING");
      await this.repository.save(task);
    }
  }

  private assertPermittedProviderResult(
    result: ProviderRunResult,
    input: CreateTaskInput
  ): void {
    if (input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("INVALID_PROVIDER_RESULT");
    }
    const demoProfile = requireStageADemoProfile(
      input as PortraitTaskInput
    );
    if (result.previewUrl !== demoProfile.preview.url) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

    const expectedSequence = permittedProviderSequences.find((sequence) =>
      sequence.length === result.events.length &&
      sequence.every(([type, phase, copyKey], index) => {
        const event = result.events[index];
        return event?.type === type &&
          event.phase === phase &&
          event.copyKey === copyKey &&
          event.visibility === "PREVIEW";
      })
    );

    if (!expectedSequence) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

    const parameterEvent = result.events.find(
      (event) => event.type === "PARAM_DIRECTION_APPLIED"
    );
    const parameterPayload = parameterEvent?.payload as
      | Record<string, unknown>
      | undefined;
    if (parameterEvent && parameterPayload?.direction !== input.direction) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

    const previewEvent = result.events.at(-1);
    const previewPayload = previewEvent?.payload as
      | Record<string, unknown>
      | undefined;
    if (
      previewEvent?.type !== "PREVIEW_READY" ||
      previewPayload?.watermarked !== true ||
      previewPayload.downloadable !== false
    ) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }
  }

  private async requireTask(
    userId: string,
    taskId: string
  ): Promise<StoredTask> {
    const task = await this.repository.findForUser(userId, taskId);
    if (!task) {
      throw new Error("TASK_NOT_FOUND");
    }
    return task;
  }

  private async append(task: StoredTask, event: ProviderEvent): Promise<void> {
    const fullEvent = sanitizeEditTraceEvent({
      ...event,
      eventId: randomUUID(),
      taskId: task.taskId,
      sequence: task.lastSequence + 1
    });
    await this.appendSanitized(task, fullEvent);
  }

  private sanitizeProviderEventBatch(
    task: StoredTask,
    events: ProviderEvent[]
  ): EditTraceEvent[] {
    return events.map((event, index) => sanitizeEditTraceEvent({
      ...event,
      eventId: randomUUID(),
      taskId: task.taskId,
      sequence: task.lastSequence + index + 1
    }));
  }

  private async appendSanitized(
    task: StoredTask,
    event: EditTraceEvent
  ): Promise<void> {
    await this.repository.appendEvent(event);
    task.lastSequence = event.sequence;
    await this.repository.save(task);
  }

  private snapshot(task: StoredTask): TaskSnapshot {
    return {
      taskId: task.taskId,
      status: task.status,
      tool: task.tool,
      lastSequence: task.lastSequence,
      ...(task.previewUrl ? { previewUrl: task.previewUrl } : {}),
      ...(task.failureCode ? { failureCode: task.failureCode } : {}),
      ...(task.diagnosis ? { diagnosis: structuredClone(task.diagnosis) } : {}),
      ...(task.selectedDirection
        ? { selectedDirection: task.selectedDirection }
        : {})
    };
  }
}
