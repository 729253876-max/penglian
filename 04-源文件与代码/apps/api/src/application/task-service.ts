import { randomUUID } from "node:crypto";
import type {
  CreateTaskInput,
  EditTraceEvent,
  TaskSnapshot
} from "@photo-ai/contracts";
import {
  sanitizeEditTraceEvent,
  sanitizeProviderReceiptEvent
} from "../domain/edit-trace-policy.js";
import { RepairJournalService } from "./repair-journal-service.js";
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
  type FidelityCheck,
  type PortraitQualityGate,
  type QualityGateResult
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

const fidelityChecks = new Set<FidelityCheck>([
  "FACE_COUNT",
  "IDENTITY",
  "STRUCTURE",
  "NON_TARGET_REGION",
  "ARTIFACTS"
]);

export class TaskService {
  private readonly qualityGate: PortraitQualityGate;
  private readonly usesStageADemoProfile: boolean;
  private readonly repairJournal = new RepairJournalService();

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
    this.usesStageADemoProfile = assetReader instanceof StageADemoAssetReader;
    this.qualityGate = qualityGate ?? (
      this.usesStageADemoProfile
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
        const receipts = await this.sanitizeProviderEventBatch(task, candidate.receipts);
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
      let quality: QualityGateResult;
      let qualityEvent: EditTraceEvent;
      try {
        quality = this.assertValidQualityGateResult(
          await this.qualityGate.evaluate({
            candidateAssetId: candidate.candidateAssetId,
            watermarkedPreviewUrl: candidate.watermarkedPreviewUrl,
            direction: (task.input as PortraitTaskInput).direction
          })
        );
        const unsafeQualityEvent: ProviderEvent = quality.passed
          ? {
              type: "QUALITY_CHECK_PASSED",
              phase: "QUALITY",
              occurredAt: occurredAt(this.clock),
              visibility: "PREVIEW",
              evidenceSource: "QUALITY_GATE",
              copyKey: "quality.fidelity.passed",
              payload: { checks: quality.checks }
            }
          : {
              type: "QUALITY_CHECK_FAILED",
              phase: "QUALITY",
              occurredAt: occurredAt(this.clock),
              visibility: "PREVIEW",
              evidenceSource: "QUALITY_GATE",
              copyKey: "quality.fidelity.failed",
              payload: {
                checks: quality.checks,
                failedChecks: quality.failedChecks
              }
            };
        qualityEvent = this.sanitizeEvent(task, unsafeQualityEvent);
      } catch {
        await this.failTask(task, "FIDELITY_GATE_FAILED", "QUALITY_GATE");
        return this.snapshot(task);
      }
      if (quality.passed) {
        await this.appendSanitized(task, qualityEvent);
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

      await this.appendSanitized(task, qualityEvent);
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
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !this.hasExactOwnKeys(result, [
        "candidateAssetId",
        "watermarkedPreviewUrl",
        "receipts"
      ]) ||
      typeof result.candidateAssetId !== "string" ||
      result.candidateAssetId.length === 0 ||
      typeof result.watermarkedPreviewUrl !== "string" ||
      result.watermarkedPreviewUrl.length === 0 ||
      !Array.isArray(result.receipts) ||
      result.receipts.length === 0 ||
      input.tool !== "PORTRAIT_RETOUCH"
    ) {
      throw new Error("INVALID_PROVIDER_RESULT");
    }

    if (this.usesStageADemoProfile) {
      const demoProfile = requireStageADemoProfile(input as PortraitTaskInput);
      if (result.watermarkedPreviewUrl !== demoProfile.preview.url) {
        throw new Error("INVALID_PROVIDER_RESULT");
      }
    }

    for (const parameterEvent of result.receipts.filter(
      (event) => event.type === "PARAM_DIRECTION_APPLIED"
    )) {
      const parameterPayload = parameterEvent.payload as Record<string, unknown>;
      if (parameterPayload.direction !== input.direction) {
        throw new Error("INVALID_PROVIDER_RESULT");
      }
    }

  }

  private hasExactOwnKeys(
    value: object,
    expectedKeys: readonly string[]
  ): boolean {
    const actualKeys = Reflect.ownKeys(value);
    return actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(value, key));
  }

  private assertValidQualityGateResult(value: unknown): QualityGateResult {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, "passed")
    ) {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }

    const passed = Reflect.get(value, "passed") as unknown;
    if (typeof passed !== "boolean") {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }
    const expectedKeys = passed
      ? ["passed", "checks"]
      : ["passed", "checks", "failedChecks"];
    if (!this.hasExactOwnKeys(value, expectedKeys)) {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }

    const checks = this.snapshotCheckList(Reflect.get(value, "checks"));
    if (passed) {
      return { passed: true, checks };
    }

    const failedChecks = this.snapshotCheckList(
      Reflect.get(value, "failedChecks")
    );
    if (!failedChecks.every((check) => checks.includes(check))) {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }
    return { passed: false, checks, failedChecks };
  }

  private snapshotCheckList(value: unknown): FidelityCheck[] {
    if (!Array.isArray(value)) {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }
    const length = Reflect.get(value, "length") as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > fidelityChecks.size
    ) {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }
    const expectedKeys = [
      ...Array.from({ length }, (_, index) => String(index)),
      "length"
    ];
    if (!this.hasExactOwnKeys(value, expectedKeys)) {
      throw new Error("INVALID_QUALITY_GATE_RESULT");
    }

    const snapshot: FidelityCheck[] = [];
    const seen = new Set<FidelityCheck>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("INVALID_QUALITY_GATE_RESULT");
      }
      const check = descriptor.value as unknown;
      if (
        typeof check !== "string" ||
        !fidelityChecks.has(check as FidelityCheck) ||
        seen.has(check as FidelityCheck)
      ) {
        throw new Error("INVALID_QUALITY_GATE_RESULT");
      }
      const trustedCheck = check as FidelityCheck;
      seen.add(trustedCheck);
      snapshot.push(trustedCheck);
    }
    return snapshot;
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
    await this.appendSanitized(task, this.sanitizeEvent(task, event));
  }

  private sanitizeEvent(
    task: StoredTask,
    event: ProviderEvent
  ): EditTraceEvent {
    return sanitizeEditTraceEvent({
      ...event,
      eventId: randomUUID(),
      taskId: task.taskId,
      sequence: task.lastSequence + 1
    });
  }

  private async sanitizeProviderEventBatch(
    task: StoredTask,
    events: ProviderEvent[]
  ): Promise<EditTraceEvent[]> {
    const sanitized = events.map((event, index) => sanitizeProviderReceiptEvent({
      ...event,
      eventId: randomUUID(),
      taskId: task.taskId,
      sequence: task.lastSequence + index + 1
    }));
    const previewHistory = await this.repository.eventsAfter(
      task.userId,
      task.taskId,
      0
    );
    for (const event of sanitized) {
      this.repairJournal.validateNext(previewHistory, event);
      previewHistory.push(event);
    }
    this.repairJournal.validateNext(previewHistory, sanitizeEditTraceEvent({
      type: "QUALITY_CHECK_STARTED",
      phase: "QUALITY",
      occurredAt: occurredAt(this.clock),
      visibility: "PREVIEW",
      evidenceSource: "QUALITY_GATE",
      copyKey: "quality.started",
      payload: {},
      eventId: randomUUID(),
      taskId: task.taskId,
      sequence: task.lastSequence + sanitized.length + 1
    }));
    return sanitized;
  }

  private async appendSanitized(
    task: StoredTask,
    event: EditTraceEvent
  ): Promise<void> {
    const history = await this.repository.eventsAfter(
      task.userId,
      task.taskId,
      0
    );
    this.repairJournal.validateNext(history, event);
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
