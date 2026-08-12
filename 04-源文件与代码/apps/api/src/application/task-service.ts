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
import {
  DeterministicPortraitQualityGate,
  FailClosedPortraitQualityGate,
  type PortraitQualityGate
} from "./portrait-quality-gate.js";

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

export interface ProviderCandidate {
  candidateAssetId: string;
  watermarkedPreviewUrl: string;
  receipts: Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">[];
}

export interface ImageProvider {
  runPreview(input: CreateTaskInput, attempt: 1 | 2): Promise<ProviderCandidate>;
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

const permittedProviderSequence: readonly ProviderEventRule[] = [
  ["STAGE_STARTED", "RETOUCH", "portrait.stage.retouch.started"],
  ["PARAM_DIRECTION_APPLIED", "RETOUCH", "portrait.parameter.direction"],
  ["STAGE_COMPLETED", "RETOUCH", "portrait.stage.retouch.completed"]
];

export class TaskService {
  private readonly qualityGate: PortraitQualityGate;

  public constructor(
    private readonly repository: TaskRepository,
    private readonly provider: ImageProvider,
    private readonly assetReader: PortraitAssetReader,
    private readonly clock: Clock = systemClock,
    private readonly diagnosisService: PortraitDiagnosisService =
      new DeterministicPortraitDiagnosisService(),
    private readonly planService: PortraitPlanService = new PortraitPlanService(),
    qualityGate?: PortraitQualityGate
  ) {
    this.qualityGate = qualityGate ?? (
      assetReader instanceof StageADemoAssetReader
        ? new DeterministicPortraitQualityGate({ passed: true })
        : new FailClosedPortraitQualityGate()
    );
  }

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
    const selectedPlan = capturedInput.direction === "CLEAR_RESCUE"
      ? clearPlan
      : naturalPlan;
    const normalizedInput: CreateTaskInput = {
      ...capturedInput,
      direction: selectedPlan.direction,
      parameters: {
        naturalness: selectedPlan.naturalness,
        detailLevel: selectedPlan.detailLevel
      }
    };

    const task: StoredTask = {
      taskId: randomUUID(),
      userId,
      status: "REVIEWING",
      tool: capturedInput.tool,
      lastSequence: 0,
      input: normalizedInput,
      diagnosis: structuredClone(diagnosis),
      selectedDirection: selectedPlan.direction
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
      copyKey: "portrait.plan.clear",
      payload: { direction: clearPlan.direction }
    });
    await this.append(task, {
      type: "PLAN_SELECTED",
      phase: "PLAN",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "USER_SELECTION",
      copyKey: "portrait.plan.selected",
      payload: { direction: selectedPlan.direction }
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

    for (const attempt of [1, 2] as const) {
      let candidate: ProviderCandidate;
      try {
        candidate = await this.provider.runPreview(
          structuredClone(task.input),
          attempt
        );
        this.assertPermittedProviderCandidate(candidate, task.input);
        const receipts = this.sanitizeProviderEventBatch(task, candidate.receipts);
        for (const receipt of receipts) {
          await this.appendSanitized(task, receipt);
        }
      } catch {
        await this.failTask(task, "PREVIEW_PROVIDER_FAILED", "SYSTEM_CHECK");
        return this.snapshot(task);
      }

      task.status = transition(task.status, "QUALITY_CHECKING");
      await this.repository.save(task);
      await this.append(task, {
        type: "QUALITY_CHECK_STARTED",
        phase: "QUALITY",
        occurredAt: occurredAt(this.clock),
        visibility: "PREVIEW",
        evidenceSource: "QUALITY_GATE",
        copyKey: "quality.started",
        payload: {}
      });
      const quality = await this.qualityGate.evaluate({
        candidateAssetId: candidate.candidateAssetId,
        watermarkedPreviewUrl: candidate.watermarkedPreviewUrl,
        direction: (task.input as PortraitTaskInput).direction
      });
      if (quality.passed) {
        await this.append(task, {
          type: "QUALITY_CHECK_PASSED",
          phase: "QUALITY",
          occurredAt: occurredAt(this.clock),
          visibility: "PREVIEW",
          evidenceSource: "QUALITY_GATE",
          copyKey: "quality.fidelity.passed",
          payload: { checks: quality.checks }
        });
        await this.append(task, {
          type: "PREVIEW_READY",
          phase: "DELIVERY",
          occurredAt: occurredAt(this.clock),
          visibility: "PREVIEW",
          evidenceSource: "QUALITY_GATE",
          copyKey: "preview.ready",
          payload: { watermarked: true, downloadable: false }
        });
        task.status = transition(task.status, "SUCCEEDED");
        task.previewUrl = candidate.watermarkedPreviewUrl;
        await this.repository.save(task);
        return this.snapshot(task);
      }

      await this.append(task, {
        type: "QUALITY_CHECK_FAILED",
        phase: "QUALITY",
        occurredAt: occurredAt(this.clock),
        visibility: "PREVIEW",
        evidenceSource: "QUALITY_GATE",
        copyKey: "quality.fidelity.failed",
        payload: { checks: quality.checks, failedChecks: quality.failedChecks }
      });
      if (attempt === 1) {
        task.status = transition(task.status, "PROCESSING");
        await this.repository.save(task);
        await this.append(task, {
          type: "RETRY_STARTED",
          phase: "RETOUCH",
          occurredAt: occurredAt(this.clock),
          visibility: "PREVIEW",
          evidenceSource: "SYSTEM_CHECK",
          copyKey: "portrait.retry.started",
          payload: { attempt: 2 }
        });
      } else {
        await this.failTask(task, "FIDELITY_GATE_FAILED", "QUALITY_GATE");
      }
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

  private assertPermittedProviderCandidate(
    result: ProviderCandidate,
    input: CreateTaskInput
  ): void {
    if (input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("INVALID_PROVIDER_RESULT");
    }
    const demoProfile = requireStageADemoProfile(
      input as PortraitTaskInput
    );
    if (
      !result.candidateAssetId ||
      result.watermarkedPreviewUrl !== demoProfile.preview.url
    ) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

    const expectedSequence =
      permittedProviderSequence.length === result.receipts.length &&
      permittedProviderSequence.every(([type, phase, copyKey], index) => {
        const event = result.receipts[index];
        return event?.type === type &&
          event.phase === phase &&
          event.copyKey === copyKey &&
          event.visibility === "PREVIEW" &&
          event.evidenceSource === "PROVIDER_RECEIPT";
      });

    if (!expectedSequence) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

    const parameterEvent = result.receipts.find(
      (event) => event.type === "PARAM_DIRECTION_APPLIED"
    );
    const parameterPayload = parameterEvent?.payload as
      | Record<string, unknown>
      | undefined;
    if (parameterEvent && parameterPayload?.direction !== input.direction) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

  }

  private async failTask(
    task: StoredTask,
    failureCode: "PREVIEW_PROVIDER_FAILED" | "FIDELITY_GATE_FAILED",
    evidenceSource: "SYSTEM_CHECK" | "QUALITY_GATE"
  ): Promise<void> {
    task.status = transition(task.status, "FAILED");
    task.failureCode = failureCode;
    task.noCharge = true;
    delete task.previewUrl;
    await this.append(task, {
      type: "TASK_FAILED",
      phase: "DELIVERY",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource,
      copyKey: "preview.provider.failed",
      payload: { code: failureCode }
    });
    await this.repository.save(task);
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
      ...(task.noCharge ? { noCharge: true as const } : {}),
      ...(task.diagnosis ? { diagnosis: structuredClone(task.diagnosis) } : {}),
      ...(task.selectedDirection
        ? { selectedDirection: task.selectedDirection }
        : {})
    };
  }
}
