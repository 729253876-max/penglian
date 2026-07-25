import type { TaskStatus } from "@photo-ai/contracts";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  REVIEWING: ["DIAGNOSING", "REJECTED", "FAILED", "CANCELED"],
  DIAGNOSING: ["AWAITING_CONFIRMATION", "FAILED"],
  AWAITING_CONFIRMATION: ["QUEUED", "CANCELED"],
  QUEUED: ["PROCESSING", "FAILED", "CANCELED"],
  PROCESSING: ["QUALITY_CHECKING", "FAILED"],
  QUALITY_CHECKING: ["PROCESSING", "SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  REJECTED: [],
  CANCELED: []
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function transition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal task transition: ${from} -> ${to}`);
  }

  return to;
}
