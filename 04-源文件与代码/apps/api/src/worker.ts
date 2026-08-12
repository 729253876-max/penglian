import type { Clock } from "./domain/clock.js";
import { systemClock } from "./domain/clock.js";
import type { JobRepository, JobType, LeasedJob } from "./application/job-service.js";
import type { UploadFinalizationService } from "./application/upload-finalization-service.js";
import type { ModerationService } from "./application/moderation-service.js";
import type { ObjectStorage } from "./ports/object-storage.js";

export type JobHandler = (job: LeasedJob) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;
export type WaitForWork = (signal: AbortSignal) => Promise<void>;

const leaseMs = 30_000;
const leaseRenewIntervalMs = 10_000;

export class UploadWorker {
  public constructor(
    private readonly jobs: JobRepository,
    private readonly handlers: JobHandlers,
    private readonly clock: Clock = systemClock
  ) {}

  public async run(
    workerId: string,
    signal: AbortSignal,
    waitForWork: WaitForWork
  ): Promise<void> {
    while (!signal.aborted) {
      const handled = await this.runOneJob(workerId);
      if (signal.aborted) return;
      if (!handled) await waitForWork(signal);
    }
  }

  public async runOneJob(workerId: string): Promise<boolean> {
    const now = this.clock.now();
    const job = await this.jobs.leaseNext(workerId, now, leaseMs);
    if (!job) return false;
    const handler = this.handlers[job.type];
    if (!handler) {
      await this.jobs.fail(job.jobId, job.leaseToken, "JOB_HANDLER_NOT_CONFIGURED");
      return true;
    }
    const renewal = new AbortController();
    let renewalError: unknown;
    const renewLease = this.renewLease(job, renewal.signal).catch((error: unknown) => {
      renewalError = error;
    });
    try {
      await handler(job);
      renewal.abort();
      await renewLease;
      if (renewalError) throw renewalError;
      await this.jobs.complete(job.jobId, job.leaseToken);
    } catch (error) {
      renewal.abort();
      await renewLease;
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
        ? error.message : "JOB_HANDLER_FAILED";
      if (code === "INVALID_JOB_PAYLOAD" || job.attempt >= job.maxAttempts) {
        await this.jobs.fail(job.jobId, job.leaseToken, code);
        return true;
      }
      const delayMs = job.attempt === 1 ? 30_000 : 120_000;
      await this.jobs.retry(
        job.jobId,
        job.leaseToken,
        new Date(now.getTime() + delayMs),
        code
      );
    }
    return true;
  }

  private async renewLease(job: LeasedJob, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await wait(leaseRenewIntervalMs, signal);
      if (signal.aborted) return;
      const now = this.clock.now();
      await this.jobs.renew(job.jobId, job.leaseToken, new Date(now.getTime() + leaseMs));
    }
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

interface UploadHandlerDependencies {
  normalization: Pick<UploadFinalizationService, "normalizeAcceptedUpload">;
  moderation: Pick<ModerationService, "process">;
  storage: Pick<ObjectStorage, "deleteObject">;
  clock?: Clock;
}

export function createUploadJobHandlers(
  dependencies: UploadHandlerDependencies
): Required<JobHandlers> {
  const clock = dependencies.clock ?? systemClock;
  return {
    NORMALIZE_UPLOAD: async (job) => {
      const payload = parseNormalizePayload(job.payload);
      const prefix = `users/${payload.userId}/uploads/${payload.sessionId}`;
      if (payload.sourceObjectKey !== `${prefix}/original`) throw new Error("INVALID_JOB_PAYLOAD");
      await dependencies.normalization.normalizeAcceptedUpload({
        ...payload,
        normalizedObjectKey: `${prefix}/normalized`,
        auditObjectKey: `${prefix}/audit`,
        now: clock.now()
      });
    },
    MODERATE_UPLOAD: async (job) => {
      const payload = parseModerationPayload(job.payload);
      await dependencies.moderation.process({ ...payload, now: clock.now() });
    },
    CLEANUP_UPLOAD: async (job) => {
      const objectKeys = parseCleanupPayload(job.payload);
      for (const objectKey of objectKeys) await dependencies.storage.deleteObject(objectKey);
    }
  };
}

function parseNormalizePayload(payload: Record<string, unknown>) {
  if (
    typeof payload.sessionId !== "string" || !safeSegment(payload.sessionId) ||
    typeof payload.userId !== "string" || !safeSegment(payload.userId) ||
    typeof payload.sourceObjectKey !== "string"
  ) throw new Error("INVALID_JOB_PAYLOAD");
  return {
    sessionId: payload.sessionId,
    userId: payload.userId,
    sourceObjectKey: payload.sourceObjectKey
  };
}

function parseModerationPayload(payload: Record<string, unknown>) {
  if (
    typeof payload.sessionId !== "string" || !safeSegment(payload.sessionId) ||
    typeof payload.auditObjectKey !== "string" || !validObjectKey(payload.auditObjectKey, "audit") ||
    typeof payload.attempt !== "number" || !Number.isInteger(payload.attempt) || payload.attempt < 1 || payload.attempt > 3 ||
    typeof payload.startedAt !== "string"
  ) throw new Error("INVALID_JOB_PAYLOAD");
  const startedAt = new Date(payload.startedAt);
  if (Number.isNaN(startedAt.getTime())) throw new Error("INVALID_JOB_PAYLOAD");
  return {
    sessionId: payload.sessionId,
    auditObjectKey: payload.auditObjectKey,
    attempt: payload.attempt,
    startedAt
  };
}

function parseCleanupPayload(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.objectKeys) || payload.objectKeys.length < 1 ||
      !payload.objectKeys.every((key) => typeof key === "string" && validObjectKey(key))) {
    throw new Error("INVALID_JOB_PAYLOAD");
  }
  return payload.objectKeys as string[];
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validObjectKey(value: string, kind?: string): boolean {
  const match = /^users\/([A-Za-z0-9_-]{1,128})\/uploads\/([A-Za-z0-9_-]{1,128})\/(original|normalized|audit|preview)$/.exec(value);
  return Boolean(match && (!kind || match[3] === kind));
}
