import type { EditTraceEvent } from "@photo-ai/contracts";
import type {
  StoredTask,
  TaskRepository
} from "../application/task-service.js";

export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, StoredTask>();
  private readonly events = new Map<string, EditTraceEvent[]>();

  public async save(task: StoredTask): Promise<void> {
    this.tasks.set(task.taskId, structuredClone(task));
  }

  public async find(taskId: string): Promise<StoredTask | undefined> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  public async claimAwaitingConfirmation(
    taskId: string
  ): Promise<StoredTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "AWAITING_CONFIRMATION") {
      return undefined;
    }

    const claimedTask: StoredTask = {
      ...structuredClone(task),
      status: "QUEUED"
    };
    this.tasks.set(taskId, structuredClone(claimedTask));
    return structuredClone(claimedTask);
  }

  public async appendEvent(event: EditTraceEvent): Promise<void> {
    const current = this.events.get(event.taskId) ?? [];
    const expectedSequence = (current.at(-1)?.sequence ?? 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error("EVENT_SEQUENCE_CONFLICT");
    }
    current.push(structuredClone(event));
    this.events.set(event.taskId, current);
  }

  public async eventsAfter(
    taskId: string,
    sequence: number
  ): Promise<EditTraceEvent[]> {
    return (this.events.get(taskId) ?? [])
      .filter((event) => event.sequence > sequence)
      .map((event) => structuredClone(event));
  }
}
