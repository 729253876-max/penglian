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

  public async appendEvent(event: EditTraceEvent): Promise<void> {
    const current = this.events.get(event.taskId) ?? [];
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
