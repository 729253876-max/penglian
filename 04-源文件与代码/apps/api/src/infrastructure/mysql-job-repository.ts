import { randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  EnqueuedJob,
  EnqueueJobInput,
  JobRepository,
  JobType,
  LeasedJob
} from "../application/job-service.js";
import { withTransaction } from "./mysql.js";

interface JobIdRow extends RowDataPacket {
  id: string;
}

interface JobRow extends RowDataPacket {
  id: string;
  type: JobType;
  payload_json: string | Record<string, unknown>;
  attempt: number;
  max_attempts: number;
}

export class MySqlJobRepository implements JobRepository {
  public constructor(private readonly pool: Pool) {}

  public async enqueue(input: EnqueueJobInput): Promise<EnqueuedJob> {
    validateEnqueueInput(input);
    return withTransaction(this.pool, async (connection) => {
      const jobId = randomUUID();
      await connection.execute<ResultSetHeader>(
        `INSERT INTO jobs
          (id, type, payload_json, status, attempt, max_attempts, run_after,
           lease_owner, lease_token, lease_expires_at, idempotency_key,
           last_error_code)
         VALUES (?, ?, ?, 'READY', 0, ?, ?, NULL, NULL, NULL, ?, NULL)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          jobId,
          input.type,
          JSON.stringify(input.payload),
          input.maxAttempts,
          input.runAfter,
          input.idempotencyKey
        ]
      );
      const [rows] = await connection.execute<JobIdRow[]>(
        "SELECT id FROM jobs WHERE idempotency_key = ? FOR UPDATE",
        [input.idempotencyKey]
      );
      const storedId = rows[0]?.id;
      if (!storedId) {
        throw new Error("JOB_ENQUEUE_FAILED");
      }
      return { jobId: storedId };
    });
  }

  public async leaseNext(
    workerId: string,
    now: Date,
    leaseMs: number
  ): Promise<LeasedJob | undefined> {
    if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("INVALID_JOB_LEASE_REQUEST");
    }
    return withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<JobRow[]>(
        `SELECT id, type, payload_json, attempt, max_attempts
         FROM jobs
         WHERE attempt < max_attempts
           AND (
             (status = 'READY' AND run_after <= ?)
             OR (status = 'LEASED' AND lease_expires_at <= ?)
           )
         ORDER BY run_after ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [now, now]
      );
      const row = rows[0];
      if (!row) {
        return undefined;
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const attempt = row.attempt + 1;
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE jobs
         SET status = 'LEASED', attempt = ?, lease_owner = ?, lease_token = ?,
             lease_expires_at = ?
         WHERE id = ?`,
        [attempt, workerId, leaseToken, leaseExpiresAt, row.id]
      );
      if (result.affectedRows !== 1) {
        throw new Error("JOB_LEASE_FAILED");
      }

      return {
        jobId: row.id,
        type: row.type,
        payload: parsePayload(row.payload_json),
        attempt,
        maxAttempts: row.max_attempts,
        leaseToken,
        leaseExpiresAt
      };
    });
  }

  public async complete(jobId: string, leaseToken: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE jobs
       SET status = 'COMPLETED', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL
       WHERE id = ? AND status = 'LEASED' AND lease_token = ?`,
      [jobId, leaseToken]
    );
    requireLease(result);
  }

  public async retry(
    jobId: string,
    leaseToken: string,
    nextRunAt: Date,
    errorCode: string
  ): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE jobs
       SET status = 'READY', run_after = ?, lease_owner = NULL,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = ?
       WHERE id = ? AND status = 'LEASED' AND lease_token = ?`,
      [nextRunAt, errorCode, jobId, leaseToken]
    );
    requireLease(result);
  }
}

function validateEnqueueInput(input: EnqueueJobInput): void {
  if (
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts <= 0 ||
    input.maxAttempts > 255 ||
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 191
  ) {
    throw new Error("INVALID_JOB_INPUT");
  }
}

function parsePayload(value: string | Record<string, unknown>): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_JOB_PAYLOAD");
  }
  return parsed;
}

function requireLease(result: ResultSetHeader): void {
  if (result.affectedRows !== 1) {
    throw new Error("JOB_LEASE_LOST");
  }
}
