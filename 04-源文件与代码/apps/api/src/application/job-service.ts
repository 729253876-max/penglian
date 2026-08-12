export type JobType = "NORMALIZE_UPLOAD" | "MODERATE_UPLOAD" | "CLEANUP_UPLOAD";

export interface EnqueueJobInput {
  type: JobType;
  payload: Record<string, unknown>;
  maxAttempts: number;
  runAfter: Date;
  idempotencyKey: string;
}

export interface EnqueuedJob {
  jobId: string;
}

export interface LeasedJob extends EnqueuedJob {
  type: JobType;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

export interface JobRepository {
  enqueue(input: EnqueueJobInput): Promise<EnqueuedJob>;
  leaseNext(workerId: string, now: Date, leaseMs: number): Promise<LeasedJob | undefined>;
  renew(jobId: string, leaseToken: string, leaseExpiresAt: Date): Promise<void>;
  complete(jobId: string, leaseToken: string): Promise<void>;
  retry(
    jobId: string,
    leaseToken: string,
    nextRunAt: Date,
    errorCode: string
  ): Promise<void>;
  fail(jobId: string, leaseToken: string, errorCode: string): Promise<void>;
}
