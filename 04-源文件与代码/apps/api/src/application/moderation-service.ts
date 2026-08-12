import type { ContentModerator, ModerationResult } from "../ports/content-moderator.js";

type TerminalState = "APPROVED" | "REJECTED" | "FAILED";

interface ProcessInput {
  sessionId: string;
  auditObjectKey: string;
  attempt: number;
  startedAt: Date;
  now: Date;
}

interface TerminalInput {
  sessionId: string;
  attempt: number;
  expectedState: "REVIEWING";
  nextState: TerminalState;
  outcome: ModerationResult["outcome"];
  publicReason?: "CONTENT_UNSUPPORTED" | "SAFETY_CHECK_UNAVAILABLE";
  now: Date;
}

interface RetryInput extends ProcessInput {
  delayMs: number;
  nextRunAt: Date;
  errorCode: string;
}

export interface ModerationRepository {
  recordTerminal(input: TerminalInput): Promise<void>;
  scheduleRetry(input: RetryInput): Promise<void>;
}

export type ProcessModerationResult =
  | { terminal: true; state: TerminalState }
  | { terminal: false; nextRunAt: Date };

export class ModerationService {
  public constructor(
    private readonly moderator: ContentModerator,
    private readonly repository: ModerationRepository
  ) {}

  public async process(input: ProcessInput): Promise<ProcessModerationResult> {
    if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 3) {
      throw new Error("INVALID_MODERATION_ATTEMPT");
    }
    const result = await this.moderator.review(input);
    if (result.outcome === "PASS") return this.finish(input, result, "APPROVED");
    if (result.outcome === "REJECT") return this.finish(input, result, "REJECTED", "CONTENT_UNSUPPORTED");
    if (result.outcome === "SUSPECTED") {
      if (input.attempt >= 2) return this.finish(input, result, "REJECTED", "CONTENT_UNSUPPORTED");
      return this.retry(input, 30_000, "MODERATION_SUSPECTED_RECHECK");
    }
    if (!result.retryable || input.attempt >= 3) {
      return this.finish(input, result, "FAILED", "SAFETY_CHECK_UNAVAILABLE");
    }
    const delayMs = input.attempt === 1 ? 30_000 : 120_000;
    return this.retry(input, delayMs, result.code);
  }

  private async finish(
    input: ProcessInput,
    result: ModerationResult,
    nextState: TerminalState,
    publicReason?: TerminalInput["publicReason"]
  ): Promise<ProcessModerationResult> {
    await this.repository.recordTerminal({
      sessionId: input.sessionId,
      attempt: input.attempt,
      expectedState: "REVIEWING",
      nextState,
      outcome: result.outcome,
      ...(publicReason ? { publicReason } : {}),
      now: input.now
    });
    return { terminal: true, state: nextState };
  }

  private async retry(
    input: ProcessInput,
    delayMs: number,
    errorCode: string
  ): Promise<ProcessModerationResult> {
    const nextRunAt = new Date(input.now.getTime() + delayMs);
    if (nextRunAt.getTime() - input.startedAt.getTime() > 5 * 60_000) {
      return this.finish(
        input,
        { outcome: "SERVICE_ERROR", retryable: false, code: "MODERATION_DEADLINE_EXCEEDED" },
        "FAILED",
        "SAFETY_CHECK_UNAVAILABLE"
      );
    }
    await this.repository.scheduleRetry({ ...input, delayMs, nextRunAt, errorCode });
    return { terminal: false, nextRunAt };
  }
}
