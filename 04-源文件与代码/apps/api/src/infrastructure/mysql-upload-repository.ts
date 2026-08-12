import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { PrivateObjectMetadata } from "../ports/object-storage.js";
import type { StoredUploadSession, UploadSessionRepository } from "../application/upload-session-service.js";
import type { NormalizedImage } from "../ports/image-normalizer.js";
import type { ModerationResult } from "../ports/content-moderator.js";
import type { UploadState } from "@photo-ai/contracts";
import { withTransaction } from "./mysql.js";

interface LockedUploadRow extends RowDataPacket {
  id: string;
  state: string;
  object_key: string;
}

interface AcceptUploadedObjectInput {
  sessionId: string;
  userId: string;
  sourceObjectKey: string;
  expectedEtag: string;
  expectedState: "INIT";
  nextState: "UPLOADED";
  source: PrivateObjectMetadata;
  normalizeJobIdempotencyKey: string;
  now: Date;
}

type IdGenerator = () => string;

export class MySqlUploadRepository implements UploadSessionRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly idGenerator: IdGenerator = randomUUID
  ) {}

  public async hasActiveMetadataRemovalConsent(userId: string, version: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM consents
       WHERE user_id = ? AND consent_type = 'METADATA_REMOVAL'
         AND policy_version = ? AND granted = TRUE AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`,
      [userId, version]
    );
    return rows.length > 0;
  }

  public async insert(session: StoredUploadSession): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (id, user_id, state, object_key, file_name, declared_size_bytes,
         consent_policy_version, etag, quality_warning, failure_code,
         moderation_started_at, credential_issue_count, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      [session.id, session.userId, session.state, session.objectKey, session.fileName,
       session.declaredSizeBytes, session.consentPolicyVersion, session.credentialIssueCount,
       session.expiresAt, session.createdAt, session.updatedAt]
    );
  }

  public async findOwned(sessionId: string, userId: string): Promise<StoredUploadSession | undefined> {
    const [rows] = await this.pool.execute<UploadSessionRow[]>(
      `SELECT id, user_id, state, object_key, file_name, declared_size_bytes,
              consent_policy_version, credential_issue_count, expires_at, created_at, updated_at
       FROM upload_sessions WHERE id = ? AND user_id = ? LIMIT 1`,
      [sessionId, userId]
    );
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  public async recordCredentialIssue(sessionId: string, expectedCount: number): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE upload_sessions
       SET credential_issue_count = credential_issue_count + 1
       WHERE id = ? AND credential_issue_count = ?`,
      [sessionId, expectedCount]
    );
    return result.affectedRows === 1;
  }

  public async acceptUploadedObject(input: AcceptUploadedObjectInput): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const row = await lockOwnedUpload(connection, input.sessionId, input.userId);
      if (!row) throw new Error("UPLOAD_SESSION_NOT_FOUND");
      if (row.state !== input.expectedState || row.object_key !== input.sourceObjectKey) {
        throw new Error("UPLOAD_STATE_CONFLICT");
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions
         SET state = 'UPLOADED', etag = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = ?`,
        [input.source.etag, input.now, input.sessionId, input.userId, input.expectedState]
      );
      if (updated.affectedRows !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
      await insertJob(connection, {
        id: this.idGenerator(),
        type: "NORMALIZE_UPLOAD",
        payload: {
          sessionId: input.sessionId,
          userId: input.userId,
          sourceObjectKey: input.sourceObjectKey
        },
        maxAttempts: 2,
        runAfter: input.now,
        idempotencyKey: input.normalizeJobIdempotencyKey
      });
    });
  }

  public async completeNormalization(input: NormalizeInput): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const row = await lockOwnedUpload(connection, input.sessionId, input.userId);
      if (!row) throw new Error("UPLOAD_SESSION_NOT_FOUND");
      if (row.state !== input.expectedState || row.object_key !== input.sourceObjectKey) {
        throw new Error("UPLOAD_STATE_CONFLICT");
      }
      const deleteAfter = new Date(input.now.getTime() + 7 * 24 * 60 * 60_000);
      await insertAsset(connection, this.idGenerator(), input, "NORMALIZED", input.normalized, deleteAfter);
      await insertAsset(connection, this.idGenerator(), input, "AUDIT", input.audit, deleteAfter);
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions
         SET state = 'REVIEWING', quality_warning = ?, moderation_started_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = ?`,
        [input.qualityWarning, input.now, input.now, input.sessionId, input.userId, input.expectedState]
      );
      if (updated.affectedRows !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
      await insertJob(connection, {
        id: this.idGenerator(), type: "MODERATE_UPLOAD",
        payload: { sessionId: input.sessionId, auditObjectKey: input.auditObjectKey, startedAt: input.now.toISOString(), attempt: 1 },
        maxAttempts: 3, runAfter: input.now, idempotencyKey: input.moderationJobIdempotencyKey
      });
    });
  }

  public async failNormalization(input: FailNormalizationInput): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const row = await lockOwnedUpload(connection, input.sessionId, input.userId);
      if (!row) throw new Error("UPLOAD_SESSION_NOT_FOUND");
      if (row.state !== input.expectedState || row.object_key !== input.sourceObjectKey) {
        throw new Error("UPLOAD_STATE_CONFLICT");
      }
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions
         SET state = 'FAILED', failure_code = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = ?`,
        [input.errorCode, input.now, input.sessionId, input.userId, input.expectedState]
      );
      if (updated.affectedRows !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
      await insertJob(connection, {
        id: this.idGenerator(), type: "CLEANUP_UPLOAD",
        payload: { sessionId: input.sessionId, objectKeys: [input.sourceObjectKey, input.normalizedObjectKey, input.auditObjectKey] },
        maxAttempts: 3, runAfter: input.now, idempotencyKey: input.cleanupJobIdempotencyKey
      });
    });
  }

  public async recordTerminal(input: TerminalModerationInput): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      const row = await lockUploadById(connection, input.sessionId);
      if (!row) throw new Error("UPLOAD_SESSION_NOT_FOUND");
      if (row.state !== input.expectedState) throw new Error("UPLOAD_STATE_CONFLICT");
      await insertModerationCheck(
        connection, this.idGenerator(), input.sessionId, input.attempt,
        input.outcome, null, input.now
      );
      const failureCode = input.nextState === "APPROVED" ? null : input.publicReason ?? "CONTENT_UNSUPPORTED";
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions
         SET state = ?, failure_code = ?, updated_at = ?
         WHERE id = ? AND state = ?`,
        [input.nextState, failureCode, input.now, input.sessionId, input.expectedState]
      );
      if (updated.affectedRows !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    });
  }

  public async scheduleRetry(input: RetryModerationInput): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      await insertModerationCheck(
        connection, this.idGenerator(), input.sessionId, input.attempt,
        input.errorCode === "MODERATION_SUSPECTED_RECHECK" ? "SUSPECTED" : "SERVICE_ERROR",
        input.errorCode, input.now
      );
      await insertJob(connection, {
        id: this.idGenerator(), type: "MODERATE_UPLOAD",
        payload: {
          sessionId: input.sessionId,
          auditObjectKey: input.auditObjectKey,
          startedAt: input.startedAt.toISOString(),
          attempt: input.attempt + 1
        },
        maxAttempts: 3, runAfter: input.nextRunAt,
        idempotencyKey: `moderate:${input.sessionId}:${input.attempt + 1}`
      });
    });
  }

  public async findOwnedStatus(sessionId: string, userId: string): Promise<OwnedStatus | undefined> {
    const [rows] = await this.pool.execute<OwnedStatusRow[]>(
      `SELECT u.id, u.user_id, u.state, u.object_key, u.expires_at,
              u.quality_warning, u.failure_code, a.id AS normalized_asset_id
       FROM upload_sessions u
       LEFT JOIN assets a ON a.upload_session_id = u.id
         AND a.user_id = u.user_id AND a.kind = 'NORMALIZED' AND u.state = 'APPROVED'
       WHERE u.id = ? AND u.user_id = ? LIMIT 1`,
      [sessionId, userId]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      sessionId: row.id, userId: row.user_id, state: row.state,
      objectKey: row.object_key, expiresAt: new Date(row.expires_at),
      ...(row.quality_warning !== null ? { qualityWarning: Boolean(row.quality_warning) } : {}),
      ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
      ...(row.state === "APPROVED" && row.normalized_asset_id != null
        ? { normalizedAssetId: row.normalized_asset_id }
        : {})
    };
  }

  public async cancelOwned(sessionId: string, userId: string, now: Date): Promise<void> {
    const [updated] = await this.pool.execute<ResultSetHeader>(
      `UPDATE upload_sessions SET state = 'CANCELED', updated_at = ?
       WHERE id = ? AND user_id = ? AND state IN ('INIT', 'UPLOADING', 'UPLOADED')`,
      [now, sessionId, userId]
    );
    if (updated.affectedRows === 1) return;
    const [rows] = await this.pool.execute<Array<RowDataPacket & { state: UploadState }>>(
      `SELECT state FROM upload_sessions WHERE id = ? AND user_id = ? LIMIT 1`,
      [sessionId, userId]
    );
    const state = rows[0]?.state;
    if (!state) throw new Error("UPLOAD_SESSION_NOT_FOUND");
    if (state !== "CANCELED") throw new Error("UPLOAD_STATE_CONFLICT");
  }
}

interface UploadSessionRow extends RowDataPacket {
  id: string; user_id: string; state: "INIT"; object_key: string; file_name: string;
  declared_size_bytes: number | string; consent_policy_version: string;
  credential_issue_count: number; expires_at: Date | string; created_at: Date | string; updated_at: Date | string;
}

interface OwnedStatusRow extends RowDataPacket {
  id: string; user_id: string; state: UploadState; object_key: string;
  expires_at: Date | string; quality_warning: number | boolean | null;
  failure_code: string | null;
  normalized_asset_id: string | null;
}

interface OwnedStatus {
  sessionId: string; userId: string; state: UploadState; objectKey: string;
  expiresAt: Date; qualityWarning?: boolean; failureCode?: string;
  normalizedAssetId?: string;
}

type NormalizeInput = {
  sessionId: string; userId: string; sourceObjectKey: string; normalizedObjectKey: string;
  auditObjectKey: string; expectedState: "UPLOADED"; nextState: "REVIEWING";
  moderationJobIdempotencyKey: string; now: Date;
} & NormalizedImage;

interface FailNormalizationInput {
  sessionId: string; userId: string; sourceObjectKey: string;
  normalizedObjectKey: string; auditObjectKey: string;
  expectedState: "UPLOADED"; nextState: "FAILED"; errorCode: string;
  cleanupJobIdempotencyKey: string; now: Date;
}

interface TerminalModerationInput {
  sessionId: string; attempt: number; expectedState: "REVIEWING";
  nextState: "APPROVED" | "REJECTED" | "FAILED";
  outcome: ModerationResult["outcome"];
  publicReason?: "CONTENT_UNSUPPORTED" | "SAFETY_CHECK_UNAVAILABLE";
  now: Date;
}

interface RetryModerationInput {
  sessionId: string; auditObjectKey: string; attempt: number;
  startedAt: Date; now: Date; delayMs: number; nextRunAt: Date; errorCode: string;
}

function mapSession(row: UploadSessionRow): StoredUploadSession {
  return {
    id: row.id, userId: row.user_id, state: row.state, objectKey: row.object_key,
    fileName: row.file_name, declaredSizeBytes: Number(row.declared_size_bytes),
    consentPolicyVersion: row.consent_policy_version,
    credentialIssueCount: row.credential_issue_count,
    expiresAt: new Date(row.expires_at), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at)
  };
}

async function insertAsset(
  connection: PoolConnection,
  id: string,
  input: NormalizeInput,
  kind: "NORMALIZED" | "AUDIT",
  asset: { objectKey: string; width: number; height: number; sizeBytes: number },
  deleteAfter: Date
): Promise<void> {
  await connection.execute<ResultSetHeader>(
    `INSERT INTO assets
      (id, user_id, upload_session_id, kind, object_key, mime_type,
       size_bytes, width, height, delete_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE object_key = object_key`,
    [id, input.userId, input.sessionId, kind, asset.objectKey,
     input.format === "PNG" ? "image/png" : input.format === "HEIF" ? "image/heif" : "image/jpeg",
     asset.sizeBytes, asset.width, asset.height, deleteAfter]
  );
}

async function lockOwnedUpload(
  connection: PoolConnection,
  sessionId: string,
  userId: string
): Promise<LockedUploadRow | undefined> {
  const [rows] = await connection.execute<LockedUploadRow[]>(
    `SELECT id, state, object_key
     FROM upload_sessions
     WHERE id = ? AND user_id = ?
     LIMIT 1
     FOR UPDATE`,
    [sessionId, userId]
  );
  return rows[0];
}

async function lockUploadById(
  connection: PoolConnection,
  sessionId: string
): Promise<LockedUploadRow | undefined> {
  const [rows] = await connection.execute<LockedUploadRow[]>(
    `SELECT id, state, object_key FROM upload_sessions
     WHERE id = ? LIMIT 1 FOR UPDATE`,
    [sessionId]
  );
  return rows[0];
}

async function insertModerationCheck(
  connection: PoolConnection,
  id: string,
  sessionId: string,
  attempt: number,
  outcome: ModerationResult["outcome"],
  errorCode: string | null,
  now: Date
): Promise<void> {
  await connection.execute<ResultSetHeader>(
    `INSERT INTO moderation_checks
      (id, upload_session_id, attempt, outcome, error_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [id, sessionId, attempt, outcome, errorCode, now]
  );
}

async function insertJob(
  connection: PoolConnection,
  input: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    maxAttempts: number;
    runAfter: Date;
    idempotencyKey: string;
  }
): Promise<void> {
  await connection.execute<ResultSetHeader>(
    `INSERT INTO jobs
      (id, type, payload_json, status, attempt, max_attempts, run_after,
       lease_owner, lease_token, lease_expires_at, idempotency_key, last_error_code)
     VALUES (?, ?, ?, 'READY', 0, ?, ?, NULL, NULL, NULL, ?, NULL)
     ON DUPLICATE KEY UPDATE id = id`,
    [input.id, input.type, JSON.stringify(input.payload), input.maxAttempts, input.runAfter, input.idempotencyKey]
  );
}
