import { randomUUID } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";
import type {
  IdentityRepository,
  IdentityTransaction,
  IdentityUser,
  NewIdentityBinding,
  StoredConsent,
  StoredSession
} from "../application/identity-service.js";
import { withTransaction } from "./mysql.js";

interface UserRow extends RowDataPacket {
  id: string;
  status: IdentityUser["status"];
  created_at: Date | string;
  deletion_requested_at: Date | string | null;
}

interface SessionRow extends RowDataPacket {
  id: string;
  user_id: string;
  device_id_hash: Buffer;
  access_token_hash: Buffer;
  access_expires_at: Date | string;
  refresh_token_hash: Buffer;
  refresh_expires_at: Date | string;
  last_used_at: Date | string;
  revoked_at: Date | string | null;
}

interface SessionIdRow extends RowDataPacket {
  id: string;
}

export class MySqlIdentityRepository implements IdentityRepository {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    work: (tx: IdentityTransaction) => Promise<T>
  ): Promise<T> {
    return withTransaction(this.pool, async (connection) =>
      work(new MySqlIdentityTransaction(connection))
    );
  }
}

class MySqlIdentityTransaction implements IdentityTransaction {
  public constructor(private readonly connection: PoolConnection) {}

  public async findOrCreateUser(identity: NewIdentityBinding): Promise<IdentityUser> {
    const existing = await this.findIdentityUser(identity);
    if (existing) {
      return existing;
    }

    const userId = randomUUID();
    await this.connection.execute<ResultSetHeader>(
      `INSERT INTO users
        (id, status, created_at, deletion_requested_at)
       VALUES (?, ?, ?, ?)`,
      [userId, "ACTIVE", identity.createdAt, null]
    );
    await this.connection.execute<ResultSetHeader>(
      `INSERT INTO identity_bindings
        (id, user_id, app_id, openid_ciphertext, openid_lookup_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        userId,
        identity.appId,
        identity.ciphertext,
        identity.lookupHash,
        identity.createdAt
      ]
    );

    return {
      id: userId,
      status: "ACTIVE",
      createdAt: new Date(identity.createdAt),
      deletionRequestedAt: null
    };
  }

  public async recordConsent(consent: StoredConsent): Promise<void> {
    await this.connection.execute<ResultSetHeader>(
      `INSERT INTO consents
        (id, user_id, consent_type, policy_version, granted, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        consent.id,
        consent.userId,
        consent.consentType,
        consent.policyVersion,
        consent.granted,
        consent.grantedAt,
        consent.revokedAt
      ]
    );
  }

  public async revokeSessionsForDevice(
    userId: string,
    deviceIdHash: Buffer,
    revokedAt: Date
  ): Promise<void> {
    await this.connection.execute<ResultSetHeader>(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE user_id = ? AND device_id_hash = ? AND revoked_at IS NULL`,
      [revokedAt, userId, deviceIdHash]
    );
  }

  public async revokeSessionsBeyondLimit(
    userId: string,
    activeLimit: number,
    revokedAt: Date
  ): Promise<void> {
    if (!Number.isInteger(activeLimit) || activeLimit < 0) {
      throw new Error("INVALID_SESSION_LIMIT");
    }

    const [activeRows] = await this.connection.execute<SessionIdRow[]>(
      `SELECT id
       FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY last_used_at ASC, id ASC
       FOR UPDATE`,
      [userId]
    );
    const overflow = activeRows.slice(0, Math.max(0, activeRows.length - activeLimit));
    if (overflow.length === 0) {
      return;
    }

    const placeholders = overflow.map(() => "?").join(", ");
    await this.connection.execute<ResultSetHeader>(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE id IN (${placeholders}) AND revoked_at IS NULL`,
      [revokedAt, ...overflow.map(({ id }) => id)]
    );
  }

  public async insertSession(session: StoredSession): Promise<void> {
    await this.connection.execute<ResultSetHeader>(
      `INSERT INTO sessions
        (id, user_id, device_id_hash, access_token_hash, access_expires_at,
         refresh_token_hash, refresh_expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.userId,
        session.deviceIdHash,
        session.accessTokenHash,
        session.accessExpiresAt,
        session.refreshTokenHash,
        session.refreshExpiresAt,
        session.lastUsedAt,
        session.revokedAt
      ]
    );
  }

  public async findSessionByRefreshHashForUpdate(
    refreshTokenHash: Buffer
  ): Promise<StoredSession | undefined> {
    return this.findSessionForUpdate("refresh_token_hash", refreshTokenHash);
  }

  public async findSessionByAccessHashForUpdate(
    accessTokenHash: Buffer
  ): Promise<StoredSession | undefined> {
    return this.findSessionForUpdate("access_token_hash", accessTokenHash);
  }

  public async revokeSession(sessionId: string, revokedAt: Date): Promise<void> {
    await this.connection.execute<ResultSetHeader>(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [revokedAt, sessionId]
    );
  }

  public async revokeAllSessions(userId: string, revokedAt: Date): Promise<void> {
    await this.connection.execute<ResultSetHeader>(
      `UPDATE sessions
       SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
      [revokedAt, userId]
    );
  }

  public async markUserDeleting(userId: string, requestedAt: Date): Promise<void> {
    const [result] = await this.connection.execute<ResultSetHeader>(
      `UPDATE users
       SET status = 'DELETING', deletion_requested_at = ?
       WHERE id = ? AND status <> 'DELETED'`,
      [requestedAt, userId]
    );
    if (result.affectedRows !== 1) {
      throw new Error("USER_NOT_FOUND");
    }
  }

  private async findIdentityUser(
    identity: Pick<NewIdentityBinding, "appId" | "lookupHash">
  ): Promise<IdentityUser | undefined> {
    const [rows] = await this.connection.execute<UserRow[]>(
      `SELECT u.id, u.status, u.created_at, u.deletion_requested_at
       FROM users u
       INNER JOIN identity_bindings ib ON ib.user_id = u.id
       WHERE ib.app_id = ? AND ib.openid_lookup_hash = ?
       LIMIT 1
       FOR UPDATE`,
      [identity.appId, identity.lookupHash]
    );
    const row = rows[0];
    return row ? mapUser(row) : undefined;
  }

  private async findSessionForUpdate(
    tokenColumn: "access_token_hash" | "refresh_token_hash",
    tokenHash: Buffer
  ): Promise<StoredSession | undefined> {
    const activeUserJoin = tokenColumn === "access_token_hash"
      ? "INNER JOIN users u ON u.id = s.user_id"
      : "";
    const activeUserFilter = tokenColumn === "access_token_hash"
      ? "AND u.status = 'ACTIVE'"
      : "";
    const [rows] = await this.connection.execute<SessionRow[]>(
      `SELECT s.id, s.user_id, s.device_id_hash, s.access_token_hash,
              s.access_expires_at, s.refresh_token_hash, s.refresh_expires_at,
              s.last_used_at, s.revoked_at
       FROM sessions s
       ${activeUserJoin}
       WHERE s.${tokenColumn} = ?
       ${activeUserFilter}
       LIMIT 1
       FOR UPDATE`,
      [tokenHash]
    );
    const row = rows[0];
    return row ? mapSession(row) : undefined;
  }
}

function mapUser(row: UserRow): IdentityUser {
  return {
    id: row.id,
    status: row.status,
    createdAt: asDate(row.created_at),
    deletionRequestedAt: row.deletion_requested_at === null
      ? null
      : asDate(row.deletion_requested_at)
  };
}

function mapSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    userId: row.user_id,
    deviceIdHash: Buffer.from(row.device_id_hash),
    accessTokenHash: Buffer.from(row.access_token_hash),
    accessExpiresAt: asDate(row.access_expires_at),
    refreshTokenHash: Buffer.from(row.refresh_token_hash),
    refreshExpiresAt: asDate(row.refresh_expires_at),
    lastUsedAt: asDate(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at)
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}
