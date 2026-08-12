import { describe, expect, it } from "vitest";
import type { Pool, PoolConnection, ResultSetHeader } from "mysql2/promise";
import { MySqlUploadRepository } from "../src/infrastructure/mysql-upload-repository.js";

class ScriptedConnection {
  public readonly events: string[] = [];
  public readonly statements: Array<{ sql: string; values: unknown[] }> = [];
  public readonly results: Array<[unknown, unknown]> = [];
  public async beginTransaction() { this.events.push("begin"); }
  public async commit() { this.events.push("commit"); }
  public async rollback() { this.events.push("rollback"); }
  public release() { this.events.push("release"); }
  public async execute(sql: string, values: unknown[] = []) {
    this.statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    const result = this.results.shift();
    if (!result) throw new Error("UNSCRIPTED_SQL");
    return result;
  }
}

function result(affectedRows: number): ResultSetHeader {
  return { affectedRows } as ResultSetHeader;
}

function repository(connection: ScriptedConnection) {
  const pool = {
    getConnection: async () => connection,
    execute: (sql: string, values?: unknown[]) => connection.execute(sql, values)
  } as unknown as Pool;
  return new MySqlUploadRepository(pool, () => "generated-job-id");
}

describe("MySqlUploadRepository upload acceptance", () => {
  it("atomically moves an owned INIT upload to UPLOADED and enqueues one normalization job", async () => {
    const connection = new ScriptedConnection();
    connection.results.push(
      [[{ id: "session-1", state: "INIT", object_key: "users/user-1/uploads/session-1/original" }], []],
      [result(1), []],
      [result(1), []]
    );

    await repository(connection).acceptUploadedObject({
      sessionId: "session-1", userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      expectedEtag: "etag-1", expectedState: "INIT", nextState: "UPLOADED",
      source: { sizeBytes: 1024, contentType: "image/jpeg", etag: "etag-1" },
      normalizeJobIdempotencyKey: "normalize:session-1",
      now: new Date("2030-01-02T03:04:05.000Z")
    });

    expect(connection.events).toEqual(["begin", "commit", "release"]);
    expect(connection.statements[0]?.sql).toContain("WHERE id = ? AND user_id = ? LIMIT 1 FOR UPDATE");
    expect(connection.statements[1]).toMatchObject({
      sql: expect.stringContaining("SET state = 'UPLOADED', etag = ?, updated_at = ?"),
      values: ["etag-1", new Date("2030-01-02T03:04:05.000Z"), "session-1", "user-1", "INIT"]
    });
    expect(connection.statements[2]?.sql).toContain("ON DUPLICATE KEY UPDATE id = id");
    expect(connection.statements[2]?.values).toEqual([
      "generated-job-id", "NORMALIZE_UPLOAD", JSON.stringify({ sessionId: "session-1", userId: "user-1", sourceObjectKey: "users/user-1/uploads/session-1/original" }),
      2, new Date("2030-01-02T03:04:05.000Z"), "normalize:session-1"
    ]);
  });

  it("rolls back when ownership or state does not match", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([[], []]);
    await expect(repository(connection).acceptUploadedObject({
      sessionId: "session-1", userId: "other-user", sourceObjectKey: "users/user-1/uploads/session-1/original",
      expectedEtag: "etag-1", expectedState: "INIT", nextState: "UPLOADED",
      source: { sizeBytes: 1024, contentType: "image/jpeg", etag: "etag-1" },
      normalizeJobIdempotencyKey: "normalize:session-1", now: new Date()
    })).rejects.toThrow("UPLOAD_SESSION_NOT_FOUND");
    expect(connection.events).toEqual(["begin", "rollback", "release"]);
    expect(connection.statements).toHaveLength(1);
  });
});

describe("MySqlUploadRepository session and normalization persistence", () => {
  it("stores the complete recoverable upload session and increments credentials conditionally", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([result(1), []], [result(1), []]);
    const repo = repository(connection);
    await repo.insert({
      id: "session-1", userId: "user-1", state: "INIT",
      objectKey: "users/user-1/uploads/session-1/original", fileName: "photo.jpg",
      declaredSizeBytes: 1024, consentPolicyVersion: "2026-08-02",
      credentialIssueCount: 1, expiresAt: new Date("2030-01-02T03:34:05.000Z"),
      createdAt: new Date("2030-01-02T03:04:05.000Z"), updatedAt: new Date("2030-01-02T03:04:05.000Z")
    });
    await expect(repo.recordCredentialIssue("session-1", 1)).resolves.toBe(true);
    expect(connection.statements[0]?.values).toEqual([
      "session-1", "user-1", "INIT", "users/user-1/uploads/session-1/original",
      "photo.jpg", 1024, "2026-08-02", 1,
      new Date("2030-01-02T03:34:05.000Z"), new Date("2030-01-02T03:04:05.000Z"), new Date("2030-01-02T03:04:05.000Z")
    ]);
    expect(connection.statements[1]?.sql).toContain("credential_issue_count = credential_issue_count + 1");
    expect(connection.statements[1]?.values).toEqual(["session-1", 1]);
  });

  it("atomically stores normalized and audit assets before enqueuing moderation", async () => {
    const connection = new ScriptedConnection();
    connection.results.push(
      [[{ id: "session-1", state: "UPLOADED", object_key: "users/user-1/uploads/session-1/original" }], []],
      [result(1), []], [result(1), []], [result(1), []], [result(1), []]
    );
    await repository(connection).completeNormalization({
      sessionId: "session-1", userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      format: "JPEG", source: { width: 4000, height: 3000, pixels: 12_000_000 },
      normalized: { objectKey: "users/user-1/uploads/session-1/normalized", width: 4000, height: 3000, sizeBytes: 900_000, colorSpace: "sRGB", metadataRemoved: true, hasAlpha: false },
      audit: { objectKey: "users/user-1/uploads/session-1/audit", width: 4000, height: 3000, sizeBytes: 750_000 },
      qualityWarning: false, expectedState: "UPLOADED", nextState: "REVIEWING",
      moderationJobIdempotencyKey: "moderate:session-1",
      now: new Date("2030-01-02T03:04:05.000Z")
    });
    expect(connection.events).toEqual(["begin", "commit", "release"]);
    expect(connection.statements.filter(({ sql }) => sql.startsWith("INSERT INTO assets"))).toHaveLength(2);
    expect(connection.statements[3]?.sql).toContain("moderation_started_at = ?");
    expect(connection.statements[4]?.values).toEqual([
      "generated-job-id", "MODERATE_UPLOAD",
      JSON.stringify({ sessionId: "session-1", auditObjectKey: "users/user-1/uploads/session-1/audit", startedAt: "2030-01-02T03:04:05.000Z", attempt: 1 }),
      3, new Date("2030-01-02T03:04:05.000Z"), "moderate:session-1"
    ]);
  });

  it("atomically marks permanent normalization failure and enqueues cleanup", async () => {
    const connection = new ScriptedConnection();
    connection.results.push(
      [[{ id: "session-1", state: "UPLOADED", object_key: "users/user-1/uploads/session-1/original" }], []],
      [result(1), []], [result(1), []]
    );
    await repository(connection).failNormalization({
      sessionId: "session-1", userId: "user-1",
      sourceObjectKey: "users/user-1/uploads/session-1/original",
      normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
      auditObjectKey: "users/user-1/uploads/session-1/audit",
      expectedState: "UPLOADED", nextState: "FAILED", errorCode: "IMAGE_DECODE_FAILED",
      cleanupJobIdempotencyKey: "cleanup:session-1", now: new Date("2030-01-02T03:04:05.000Z")
    });
    expect(connection.events).toEqual(["begin", "commit", "release"]);
    expect(connection.statements[1]).toMatchObject({
      sql: expect.stringContaining("SET state = 'FAILED', failure_code = ?, updated_at = ?"),
      values: ["IMAGE_DECODE_FAILED", new Date("2030-01-02T03:04:05.000Z"), "session-1", "user-1", "UPLOADED"]
    });
    expect(connection.statements[2]?.values).toEqual([
      "generated-job-id", "CLEANUP_UPLOAD",
      JSON.stringify({ sessionId: "session-1", objectKeys: ["users/user-1/uploads/session-1/original", "users/user-1/uploads/session-1/normalized", "users/user-1/uploads/session-1/audit"] }),
      3, new Date("2030-01-02T03:04:05.000Z"), "cleanup:session-1"
    ]);
  });

  it("records terminal moderation without provider details and updates state atomically", async () => {
    const connection = new ScriptedConnection();
    connection.results.push(
      [[{ id: "session-1", state: "REVIEWING", object_key: "users/user-1/uploads/session-1/original" }], []],
      [result(1), []], [result(1), []]
    );
    await repository(connection).recordTerminal({
      sessionId: "session-1", attempt: 2, expectedState: "REVIEWING",
      nextState: "REJECTED", outcome: "SUSPECTED", publicReason: "CONTENT_UNSUPPORTED",
      now: new Date("2030-01-02T03:05:05.000Z")
    });
    expect(connection.statements[1]?.values).toEqual([
      "generated-job-id", "session-1", 2, "SUSPECTED", null,
      new Date("2030-01-02T03:05:05.000Z")
    ]);
    expect(JSON.stringify(connection.statements)).not.toContain("confidence");
    expect(connection.statements[2]?.sql).toContain("SET state = ?, failure_code = ?, updated_at = ?");
    expect(connection.statements[2]?.values).toEqual([
      "REJECTED", "CONTENT_UNSUPPORTED", new Date("2030-01-02T03:05:05.000Z"),
      "session-1", "REVIEWING"
    ]);
  });

  it("records a retry and enqueues exactly the next moderation attempt", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([result(1), []], [result(1), []]);
    await repository(connection).scheduleRetry({
      sessionId: "session-1", auditObjectKey: "users/user-1/uploads/session-1/audit",
      attempt: 1, startedAt: new Date("2030-01-02T03:04:05.000Z"),
      now: new Date("2030-01-02T03:04:05.000Z"), delayMs: 30_000,
      nextRunAt: new Date("2030-01-02T03:04:35.000Z"), errorCode: "MODERATION_SERVICE_ERROR"
    });
    expect(connection.statements[0]?.values).toEqual([
      "generated-job-id", "session-1", 1, "SERVICE_ERROR", "MODERATION_SERVICE_ERROR",
      new Date("2030-01-02T03:04:05.000Z")
    ]);
    expect(connection.statements[1]?.values).toEqual([
      "generated-job-id", "MODERATE_UPLOAD",
      JSON.stringify({ sessionId: "session-1", auditObjectKey: "users/user-1/uploads/session-1/audit", startedAt: "2030-01-02T03:04:05.000Z", attempt: 2 }),
      3, new Date("2030-01-02T03:04:35.000Z"), "moderate:session-1:2"
    ]);
  });
});

describe("MySqlUploadRepository owned status and cancellation", () => {
  it("returns a normalized asset id only for an approved owned upload", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([[{
      id: "session-1", user_id: "user-1", state: "APPROVED",
      object_key: "users/user-1/uploads/session-1/original",
      expires_at: "2030-01-02T03:34:05.000Z", quality_warning: 0,
      failure_code: null, normalized_asset_id: "asset-1"
    }], []]);

    await expect(repository(connection).findOwnedStatus("session-1", "user-1"))
      .resolves.toEqual({
        sessionId: "session-1", userId: "user-1", state: "APPROVED",
        objectKey: "users/user-1/uploads/session-1/original",
        expiresAt: new Date("2030-01-02T03:34:05.000Z"),
        qualityWarning: false, normalizedAssetId: "asset-1"
      });
    expect(connection.statements[0]).toMatchObject({
      sql: expect.stringMatching(/LEFT JOIN assets a ON .*a\.upload_session_id = u\.id.*a\.user_id = u\.user_id.*a\.kind = 'NORMALIZED'.*u\.state = 'APPROVED'/),
      values: ["session-1", "user-1"]
    });
  });

  it("does not map a normalized asset id for a non-approved upload", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([[{
      id: "session-1", user_id: "user-1", state: "REVIEWING",
      object_key: "users/user-1/uploads/session-1/original",
      expires_at: "2030-01-02T03:34:05.000Z", quality_warning: 0,
      failure_code: null, normalized_asset_id: "asset-1"
    }], []]);

    await expect(repository(connection).findOwnedStatus("session-1", "user-1"))
      .resolves.not.toHaveProperty("normalizedAssetId");
  });

  it("maps only an owned upload to the safe application status record", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([[{
      id: "session-1", user_id: "user-1", state: "FAILED",
      object_key: "users/user-1/uploads/session-1/original",
      expires_at: "2030-01-02T03:34:05.000Z", quality_warning: 1,
      failure_code: "IMAGE_DECODE_FAILED"
    }], []]);
    await expect(repository(connection).findOwnedStatus("session-1", "user-1"))
      .resolves.toEqual({
        sessionId: "session-1", userId: "user-1", state: "FAILED",
        objectKey: "users/user-1/uploads/session-1/original",
        expiresAt: new Date("2030-01-02T03:34:05.000Z"),
        qualityWarning: true, failureCode: "IMAGE_DECODE_FAILED"
      });
    expect(connection.statements[0]?.values).toEqual(["session-1", "user-1"]);
  });

  it("cancels only pre-processing states and treats an existing cancellation as success", async () => {
    const connection = new ScriptedConnection();
    connection.results.push([result(1), []], [result(0), []], [[{ state: "CANCELED" }], []]);
    const repo = repository(connection);
    await expect(repo.cancelOwned("session-1", "user-1", new Date("2030-01-02T03:04:05.000Z"))).resolves.toBeUndefined();
    await expect(repo.cancelOwned("session-1", "user-1", new Date("2030-01-02T03:04:06.000Z"))).resolves.toBeUndefined();
    expect(connection.statements[0]?.sql).toContain("state IN ('INIT', 'UPLOADING', 'UPLOADED')");
  });

  it("hides missing ownership and rejects cancellation after processing starts", async () => {
    const missing = new ScriptedConnection();
    missing.results.push([result(0), []], [[], []]);
    await expect(repository(missing).cancelOwned("session-1", "other-user", new Date()))
      .rejects.toThrow("UPLOAD_SESSION_NOT_FOUND");

    const processing = new ScriptedConnection();
    processing.results.push([result(0), []], [[{ state: "REVIEWING" }], []]);
    await expect(repository(processing).cancelOwned("session-1", "user-1", new Date()))
      .rejects.toThrow("UPLOAD_STATE_CONFLICT");
  });
});
