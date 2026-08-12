import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { MySqlJobRepository } from "../src/infrastructure/mysql-job-repository.js";

const safeDatabasePattern = /^photo_ai_b2_test(?:_[a-z0-9][a-z0-9_]*)?$/;
const migrationSql = readFileSync(
  fileURLToPath(new URL("../migrations/002_upload_moderation.sql", import.meta.url)),
  "utf8"
);

type IntegrationConfiguration =
  | { ready: false; reason: string }
  | { ready: true; connectionUri: string };

interface VersionRow extends RowDataPacket {
  version: string;
}

const integrationConfiguration = loadIntegrationConfiguration(process.env);
if (!integrationConfiguration.ready) {
  console.warn(
    `[B2 MySQL jobs integration] NOT ACCEPTED; skipped: ${integrationConfiguration.reason}`
  );
}

describe(
  "MySQL 8 upload job leases (serial, destructive only inside a guarded B2 database)",
  { sequential: true, skip: !integrationConfiguration.ready },
  () => {
    let pool: Pool;
    let repository: MySqlJobRepository;

    beforeAll(async () => {
      pool = createPool({
        uri: requireConnectionUri(),
        connectionLimit: 10,
        waitForConnections: true,
        timezone: "Z"
      });
      const [versionRows] = await pool.query<VersionRow[]>(
        "SELECT VERSION() AS version"
      );
      expect(versionRows[0]?.version).toMatch(/^8\./);
      await applyMigration(pool);
      repository = new MySqlJobRepository(pool);
    });

    beforeEach(async () => {
      await pool.query("DELETE FROM jobs");
    });

    afterAll(async () => {
      await pool.query("DELETE FROM jobs");
      await pool.end();
    });

    it("applies the upload migration idempotently", async () => {
      await applyMigration(pool);

      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'jobs'"
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("returns the existing job when an idempotency key is enqueued twice", async () => {
      const first = await repository.enqueue({
        type: "NORMALIZE_UPLOAD",
        payload: { sessionId: "session-idempotent" },
        maxAttempts: 2,
        runAfter: new Date("2030-01-02T03:04:05.000Z"),
        idempotencyKey: "normalize:session-idempotent"
      });
      const second = await repository.enqueue({
        type: "NORMALIZE_UPLOAD",
        payload: { sessionId: "session-idempotent" },
        maxAttempts: 2,
        runAfter: new Date("2030-01-02T03:04:05.000Z"),
        idempotencyKey: "normalize:session-idempotent"
      });

      expect(second.jobId).toBe(first.jobId);
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM jobs"
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    it("allows exactly one worker to lease a ready job", async () => {
      const now = new Date("2030-01-02T03:04:05.000Z");
      await repository.enqueue({
        type: "NORMALIZE_UPLOAD",
        payload: { sessionId: "session-concurrent" },
        maxAttempts: 2,
        runAfter: now,
        idempotencyKey: "normalize:session-concurrent"
      });

      const claims = await Promise.all([
        repository.leaseNext("worker-1", now, 30_000),
        repository.leaseNext("worker-2", now, 30_000)
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
    });

    it("recovers an expired lease and rejects its stale token", async () => {
      const now = new Date("2030-01-02T03:04:05.000Z");
      const { jobId } = await repository.enqueue({
        type: "NORMALIZE_UPLOAD",
        payload: { sessionId: "session-recover" },
        maxAttempts: 2,
        runAfter: now,
        idempotencyKey: "normalize:session-recover"
      });
      const first = await repository.leaseNext("worker-1", now, 30_000);
      const recovered = await repository.leaseNext(
        "worker-2",
        new Date(now.getTime() + 30_001),
        30_000
      );

      expect(first?.jobId).toBe(jobId);
      expect(recovered?.jobId).toBe(jobId);
      expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
      await expect(repository.complete(jobId, first!.leaseToken))
        .rejects.toThrow("JOB_LEASE_LOST");
      await expect(repository.complete(jobId, recovered!.leaseToken))
        .resolves.toBeUndefined();
    });

    it("renews an active lease and prevents recovery at the original expiry", async () => {
      const now = new Date("2030-01-02T03:04:05.000Z");
      const { jobId } = await repository.enqueue({
        type: "NORMALIZE_UPLOAD", payload: { sessionId: "session-renew" },
        maxAttempts: 2, runAfter: now, idempotencyKey: "normalize:session-renew"
      });
      const first = await repository.leaseNext("worker-1", now, 30_000);
      const renewedUntil = new Date(now.getTime() + 60_000);

      await expect(repository.renew(jobId, first!.leaseToken, renewedUntil)).resolves.toBeUndefined();
      await expect(repository.leaseNext("worker-2", new Date(now.getTime() + 30_001), 30_000))
        .resolves.toBeUndefined();
      await expect(repository.leaseNext("worker-2", new Date(renewedUntil.getTime() + 1), 30_000))
        .resolves.toMatchObject({ jobId, attempt: 2 });
      await expect(repository.renew(jobId, first!.leaseToken, renewedUntil))
        .rejects.toThrow("JOB_LEASE_LOST");
    });

    it("reschedules a retry without leaving the old lease usable", async () => {
      const now = new Date("2030-01-02T03:04:05.000Z");
      const nextRunAt = new Date(now.getTime() + 30_000);
      const { jobId } = await repository.enqueue({
        type: "MODERATE_UPLOAD",
        payload: { sessionId: "session-retry" },
        maxAttempts: 3,
        runAfter: now,
        idempotencyKey: "moderate:session-retry"
      });
      const first = await repository.leaseNext("worker-1", now, 30_000);

      await expect(repository.retry(
        jobId,
        first!.leaseToken,
        nextRunAt,
        "MODERATION_SERVICE_ERROR"
      )).resolves.toBeUndefined();
      await expect(repository.complete(jobId, first!.leaseToken))
        .rejects.toThrow("JOB_LEASE_LOST");
      await expect(repository.leaseNext(
        "worker-2",
        new Date(nextRunAt.getTime() - 1),
        30_000
      )).resolves.toBeUndefined();
      await expect(repository.leaseNext("worker-2", nextRunAt, 30_000))
        .resolves.toMatchObject({ jobId, attempt: 2 });
    });

    it("marks a final failed lease terminal and rejects its stale token", async () => {
      const now = new Date("2030-01-02T03:04:05.000Z");
      const { jobId } = await repository.enqueue({
        type: "NORMALIZE_UPLOAD", payload: { sessionId: "session-fail" },
        maxAttempts: 1, runAfter: now, idempotencyKey: "normalize:session-fail"
      });
      const lease = await repository.leaseNext("worker-1", now, 30_000);
      await expect(repository.fail(jobId, lease!.leaseToken, "IMAGE_NORMALIZATION_FAILED"))
        .resolves.toBeUndefined();
      await expect(repository.complete(jobId, lease!.leaseToken)).rejects.toThrow("JOB_LEASE_LOST");
      await expect(repository.leaseNext("worker-2", new Date(now.getTime() + 60_000), 30_000))
        .resolves.toBeUndefined();
    });
  }
);

function loadIntegrationConfiguration(
  environment: NodeJS.ProcessEnv
): IntegrationConfiguration {
  const connectionUri = environment.MYSQL_INTEGRATION_URL?.trim();
  if (!connectionUri) {
    return { ready: false, reason: "MYSQL_INTEGRATION_URL is missing" };
  }
  if (environment.MYSQL_INTEGRATION_ALLOW !== "1") {
    return { ready: false, reason: "MYSQL_INTEGRATION_ALLOW is not 1" };
  }

  let parsed: URL;
  let databaseName: string;
  try {
    parsed = new URL(connectionUri);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error("MYSQL_INTEGRATION_REFUSED_INVALID_URL");
  }
  if (
    parsed.protocol !== "mysql:" ||
    parsed.hostname !== "127.0.0.1" ||
    !safeDatabasePattern.test(databaseName)
  ) {
    throw new Error("MYSQL_INTEGRATION_REFUSED_UNSAFE_DATABASE");
  }
  return { ready: true, connectionUri };
}

function requireConnectionUri(): string {
  if (!integrationConfiguration.ready) {
    throw new Error("MYSQL_INTEGRATION_NOT_CONFIGURED");
  }
  return integrationConfiguration.connectionUri;
}

async function applyMigration(pool: Pool): Promise<void> {
  for (const statement of migrationSql
    .split(";")
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    await pool.query(statement);
  }
}
