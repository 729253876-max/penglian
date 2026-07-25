import { randomUUID } from "node:crypto";
import type {
  CreateTaskInput,
  EditTraceEvent,
  TaskSnapshot
} from "@photo-ai/contracts";
import { sanitizeEditTraceEvent } from "../domain/edit-trace-policy.js";
import { transition } from "../domain/task-machine.js";

export interface StoredTask extends TaskSnapshot {
  input: CreateTaskInput;
}

export interface TaskRepository {
  save(task: StoredTask): Promise<void>;
  find(taskId: string): Promise<StoredTask | undefined>;
  appendEvent(event: EditTraceEvent): Promise<void>;
  eventsAfter(taskId: string, sequence: number): Promise<EditTraceEvent[]>;
}

export interface ProviderRunResult {
  previewUrl: string;
  events: Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">[];
}

export interface ImageProvider {
  runPreview(input: CreateTaskInput): Promise<ProviderRunResult>;
}

type ProviderEvent = Omit<EditTraceEvent, "eventId" | "taskId" | "sequence">;

export class TaskService {
  public constructor(
    private readonly repository: TaskRepository,
    private readonly provider: ImageProvider
  ) {}

  public async create(input: CreateTaskInput): Promise<TaskSnapshot> {
    if (input.tool !== "PORTRAIT_RETOUCH") {
      throw new Error("STAGE_A_UNSUPPORTED_TOOL");
    }

    const task: StoredTask = {
      taskId: randomUUID(),
      status: "REVIEWING",
      tool: input.tool,
      lastSequence: 0,
      input
    };
    await this.repository.save(task);

    task.status = transition(task.status, "DIAGNOSING");
    await this.repository.save(task);
    await this.append(task, {
      type: "DIAGNOSIS_STARTED",
      phase: "DIAGNOSIS",
      occurredAt: new Date().toISOString(),
      visibility: "PREVIEW",
      copyKey: "portrait.diagnosis.started",
      payload: {}
    });
    await this.append(task, {
      type: "DIAGNOSIS_FINDING",
      phase: "DIAGNOSIS",
      occurredAt: new Date().toISOString(),
      visibility: "PREVIEW",
      copyKey: "portrait.diagnosis.light",
      payload: { finding: "FACE_SHADOW_AND_BACKGROUND_HIGHLIGHT" }
    });
    await this.append(task, {
      type: "PLAN_READY",
      phase: "PLAN",
      occurredAt: new Date().toISOString(),
      visibility: "PREVIEW",
      copyKey: "portrait.plan.natural",
      payload: { direction: input.direction }
    });
    task.status = transition(task.status, "AWAITING_CONFIRMATION");
    await this.repository.save(task);
    return this.snapshot(task);
  }

  public async confirmAndRunPreview(taskId: string): Promise<TaskSnapshot> {
    const task = await this.requireTask(taskId);
    task.status = transition(task.status, "QUEUED");
    await this.repository.save(task);
    task.status = transition(task.status, "PROCESSING");
    await this.repository.save(task);

    try {
      const result = await this.provider.runPreview(task.input);
      for (const event of result.events) {
        await this.transitionForEvent(task, event);
        await this.append(task, event);
      }
      task.status = transition(task.status, "SUCCEEDED");
      task.previewUrl = result.previewUrl;
      await this.repository.save(task);
    } catch {
      task.status = transition(task.status, "FAILED");
      task.failureCode = "PREVIEW_PROVIDER_FAILED";
      await this.append(task, {
        type: "TASK_FAILED",
        phase: "DELIVERY",
        occurredAt: new Date().toISOString(),
        visibility: "PREVIEW",
        copyKey: "preview.provider.failed",
        payload: { code: task.failureCode }
      });
      await this.repository.save(task);
    }

    return this.snapshot(task);
  }

  public async get(taskId: string): Promise<TaskSnapshot> {
    return this.snapshot(await this.requireTask(taskId));
  }

  public async getEvents(
    taskId: string,
    afterSequence: number
  ): Promise<EditTraceEvent[]> {
    await this.requireTask(taskId);
    return this.repository.eventsAfter(taskId, afterSequence);
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

  private async requireTask(taskId: string): Promise<StoredTask> {
    const task = await this.repository.find(taskId);
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
    task.lastSequence = fullEvent.sequence;
    await this.repository.appendEvent(fullEvent);
    await this.repository.save(task);
  }

  private snapshot(task: StoredTask): TaskSnapshot {
    return {
      taskId: task.taskId,
      status: task.status,
      tool: task.tool,
      lastSequence: task.lastSequence,
      ...(task.previewUrl ? { previewUrl: task.previewUrl } : {}),
      ...(task.failureCode ? { failureCode: task.failureCode } : {})
    };
  }
}
