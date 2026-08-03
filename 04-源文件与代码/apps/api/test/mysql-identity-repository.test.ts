import { describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import type {
  NewIdentityBinding,
  StoredConsent,
  StoredSession
} from "../src/application/identity-service.js";
import { MySqlIdentityRepository } from "../src/infrastructure/mysql-identity-repository.js";

interface UserRow {
  id: string;
  status: "ACTIVE" | "DELETING" | "DELETED";
  created_at: Date;
  deletion_requested_at: Date | null;
}

interface IdentityRow {
  id: string;
  user_id: string;
  app_id: string;
  openid_ciphertext: Buffer;
  openid_lookup_hash: Buffer;
  created_at: Date;
}

interface ConsentRow {
  id: string;
  user_id: string;
  consent_type: string;
  policy_version: string;
  granted: boolean;
  granted_at: Date;
  revoked_at: Date | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id_hash: Buffer;
  access_token_hash: Buffer;
  access_expires_at: Date;
  refresh_token_hash: Buffer;
  refresh_expires_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
}

interface FakeDatabase {
  users: UserRow[];
  identities: IdentityRow[];
  consents: ConsentRow[];
  sessions: SessionRow[];
}

function cloneDatabase(database: FakeDatabase): FakeDatabase {
  return structuredClone(database) as FakeDatabase;
}

class BehavioralMySqlConnection {
  public database: FakeDatabase = {
    users: [],
    identities: [],
    consents: [],
    sessions: []
  };
  public readonly events: string[] = [];
  private beforeTransaction: FakeDatabase | undefined;

  public async beginTransaction(): Promise<void> {
    this.beforeTransaction = cloneDatabase(this.database);
    this.events.push("begin");
  }

  public async commit(): Promise<void> {
    this.beforeTransaction = undefined;
    this.events.push("commit");
  }

  public async rollback(): Promise<void> {
    if (this.beforeTransaction) {
      this.database = this.beforeTransaction;
    }
    this.beforeTransaction = undefined;
    this.events.push("rollback");
  }

  public release(): void {
    this.events.push("release");
  }

  public async execute(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
    const statement = sql.replace(/\s+/g, " ").trim();

    if (statement.startsWith("SELECT u.id, u.status")) {
      if (!statement.endsWith("LIMIT 1 FOR UPDATE")) {
        throw new Error("IDENTITY_LOOKUP_MUST_LOCK");
      }
      const [appId, lookupHash] = values as [string, Buffer];
      const binding = this.database.identities.find((row) =>
        row.app_id === appId && row.openid_lookup_hash.equals(lookupHash)
      );
      const user = binding
        ? this.database.users.find((row) => row.id === binding.user_id)
        : undefined;
      return [[...(user ? [user] : [])], []];
    }

    if (statement.startsWith("INSERT INTO users")) {
      const [id, status, createdAt, deletionRequestedAt] = values as [
        string,
        UserRow["status"],
        Date,
        Date | null
      ];
      this.database.users.push({
        id,
        status,
        created_at: createdAt,
        deletion_requested_at: deletionRequestedAt
      });
      return [{ affectedRows: 1 }, []];
    }

    if (statement.startsWith("INSERT INTO identity_bindings")) {
      const [id, userId, appId, ciphertext, lookupHash, createdAt] = values as [
        string,
        string,
        string,
        Buffer,
        Buffer,
        Date
      ];
      this.database.identities.push({
        id,
        user_id: userId,
        app_id: appId,
        openid_ciphertext: Buffer.from(ciphertext),
        openid_lookup_hash: Buffer.from(lookupHash),
        created_at: createdAt
      });
      return [{ affectedRows: 1 }, []];
    }

    if (statement.startsWith("INSERT INTO consents")) {
      const [id, userId, consentType, policyVersion, granted, grantedAt, revokedAt] =
        values as [string, string, string, string, boolean, Date, Date | null];
      this.database.consents.push({
        id,
        user_id: userId,
        consent_type: consentType,
        policy_version: policyVersion,
        granted,
        granted_at: grantedAt,
        revoked_at: revokedAt
      });
      return [{ affectedRows: 1 }, []];
    }

    if (statement.startsWith("INSERT INTO sessions")) {
      const [
        id,
        userId,
        deviceIdHash,
        accessTokenHash,
        accessExpiresAt,
        refreshTokenHash,
        refreshExpiresAt,
        lastUsedAt,
        revokedAt
      ] = values as [string, string, Buffer, Buffer, Date, Buffer, Date, Date, Date | null];
      this.database.sessions.push({
        id,
        user_id: userId,
        device_id_hash: Buffer.from(deviceIdHash),
        access_token_hash: Buffer.from(accessTokenHash),
        access_expires_at: accessExpiresAt,
        refresh_token_hash: Buffer.from(refreshTokenHash),
        refresh_expires_at: refreshExpiresAt,
        last_used_at: lastUsedAt,
        revoked_at: revokedAt
      });
      return [{ affectedRows: 1 }, []];
    }

    if (statement.startsWith("SELECT id FROM sessions WHERE user_id")) {
      if (!statement.endsWith("ORDER BY last_used_at ASC, id ASC FOR UPDATE")) {
        throw new Error("LRU_QUERY_MUST_LOCK_AND_ORDER");
      }
      const [targetUserId] = values as [string];
      const rows = this.database.sessions
        .filter((row) => row.user_id === targetUserId && row.revoked_at === null)
        .sort((left, right) =>
          left.last_used_at.getTime() - right.last_used_at.getTime() ||
          left.id.localeCompare(right.id)
        )
        .map(({ id }) => ({ id }));
      return [rows, []];
    }

    if (statement.startsWith("SELECT id, user_id, device_id_hash")) {
      if (!statement.endsWith("LIMIT 1 FOR UPDATE")) {
        throw new Error("SESSION_LOOKUP_MUST_LOCK");
      }
      const [hash] = values as [Buffer];
      const column = statement.includes("refresh_token_hash = ?")
        ? "refresh_token_hash"
        : "access_token_hash";
      const row = this.database.sessions.find((candidate) => candidate[column].equals(hash));
      return [[...(row ? [row] : [])], []];
    }

    if (statement.startsWith("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND device_id_hash")) {
      const [revokedAt, targetUserId, deviceIdHash] = values as [Date, string, Buffer];
      let affectedRows = 0;
      for (const row of this.database.sessions) {
        if (
          row.user_id === targetUserId &&
          row.revoked_at === null &&
          row.device_id_hash.equals(deviceIdHash)
        ) {
          row.revoked_at = revokedAt;
          affectedRows += 1;
        }
      }
      return [{ affectedRows }, []];
    }

    if (statement.startsWith("UPDATE sessions SET revoked_at = ? WHERE id IN")) {
      const [revokedAt, ...sessionIds] = values as [Date, ...string[]];
      let affectedRows = 0;
      for (const row of this.database.sessions) {
        if (sessionIds.includes(row.id) && row.revoked_at === null) {
          row.revoked_at = revokedAt;
          affectedRows += 1;
        }
      }
      return [{ affectedRows }, []];
    }

    if (statement.startsWith("UPDATE sessions SET revoked_at = ? WHERE id = ?")) {
      const [revokedAt, sessionId] = values as [Date, string];
      const row = this.database.sessions.find((candidate) => candidate.id === sessionId);
      if (row && row.revoked_at === null) {
        row.revoked_at = revokedAt;
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    }

    if (statement.startsWith("UPDATE sessions SET revoked_at = ? WHERE user_id = ?")) {
      const [revokedAt, targetUserId] = values as [Date, string];
      let affectedRows = 0;
      for (const row of this.database.sessions) {
        if (row.user_id === targetUserId && row.revoked_at === null) {
          row.revoked_at = revokedAt;
          affectedRows += 1;
        }
      }
      return [{ affectedRows }, []];
    }

    if (statement.startsWith("UPDATE users SET status = 'DELETING'")) {
      const [requestedAt, targetUserId] = values as [Date, string];
      const user = this.database.users.find((candidate) => candidate.id === targetUserId);
      if (!user || user.status === "DELETED") {
        return [{ affectedRows: 0 }, []];
      }
      user.status = "DELETING";
      user.deletion_requested_at = requestedAt;
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`UNEXPECTED_SQL: ${statement}`);
  }
}

function createRepository() {
  const connection = new BehavioralMySqlConnection();
  const pool = {
    getConnection: async () => connection
  } as unknown as Pool;
  return {
    connection,
    repository: new MySqlIdentityRepository(pool)
  };
}

function session(id: string, lastUsedAt: string): StoredSession {
  return {
    id,
    userId: "user-1",
    deviceIdHash: Buffer.alloc(32, Number(id.at(-1) ?? 0)),
    accessTokenHash: Buffer.alloc(32, 0x61 + Number(id.at(-1) ?? 0)),
    accessExpiresAt: new Date("2030-02-01T00:00:00.000Z"),
    refreshTokenHash: Buffer.alloc(32, 0x71 + Number(id.at(-1) ?? 0)),
    refreshExpiresAt: new Date("2030-03-01T00:00:00.000Z"),
    lastUsedAt: new Date(lastUsedAt),
    revokedAt: null
  };
}

describe("MySqlIdentityRepository", () => {
  it("creates and then reuses a protected identity binding inside committed transactions", async () => {
    const { connection, repository } = createRepository();
    const identity: NewIdentityBinding = {
      appId: "wx-app",
      lookupHash: Buffer.alloc(32, 0x11),
      ciphertext: Buffer.alloc(40, 0x22),
      createdAt: new Date("2030-01-01T00:00:00.000Z")
    };

    const first = await repository.transaction((tx) => tx.findOrCreateUser(identity));
    const second = await repository.transaction((tx) => tx.findOrCreateUser(identity));

    expect(second.id).toBe(first.id);
    expect(connection.database.users).toHaveLength(1);
    expect(connection.database.identities).toMatchObject([{
      user_id: first.id,
      app_id: "wx-app",
      openid_lookup_hash: identity.lookupHash,
      openid_ciphertext: identity.ciphertext
    }]);
    expect(connection.events).toEqual([
      "begin", "commit", "release",
      "begin", "commit", "release"
    ]);
  });

  it("persists consent and only token/device digests in a session row", async () => {
    const { connection, repository } = createRepository();
    const storedConsent: StoredConsent = {
      id: "consent-1",
      userId: "user-1",
      consentType: "METADATA_REMOVAL",
      policyVersion: "privacy-v1",
      granted: true,
      grantedAt: new Date("2030-01-01T00:00:00.000Z"),
      revokedAt: null
    };
    const storedSession = session("session-1", "2030-01-01T00:00:00.000Z");

    await repository.transaction(async (tx) => {
      await tx.recordConsent(storedConsent);
      await tx.insertSession(storedSession);
    });

    expect(connection.database.consents).toMatchObject([{
      consent_type: "METADATA_REMOVAL",
      policy_version: "privacy-v1",
      granted: true
    }]);
    expect(connection.database.sessions[0]).toMatchObject({
      device_id_hash: storedSession.deviceIdHash,
      access_token_hash: storedSession.accessTokenHash,
      refresh_token_hash: storedSession.refreshTokenHash
    });
  });

  it("locks token lookups and revokes the LRU overflow deterministically", async () => {
    const { connection, repository } = createRepository();
    for (let index = 1; index <= 6; index += 1) {
      const value = session(
        `session-${index}`,
        `2030-01-01T00:00:0${index}.000Z`
      );
      connection.database.sessions.push({
        id: value.id,
        user_id: value.userId,
        device_id_hash: value.deviceIdHash,
        access_token_hash: value.accessTokenHash,
        access_expires_at: value.accessExpiresAt,
        refresh_token_hash: value.refreshTokenHash,
        refresh_expires_at: value.refreshExpiresAt,
        last_used_at: value.lastUsedAt,
        revoked_at: null
      });
    }
    const revokedAt = new Date("2030-01-02T00:00:00.000Z");

    const found = await repository.transaction(async (tx) => {
      const byRefresh = await tx.findSessionByRefreshHashForUpdate(
        connection.database.sessions[2]!.refresh_token_hash
      );
      const byAccess = await tx.findSessionByAccessHashForUpdate(
        connection.database.sessions[2]!.access_token_hash
      );
      await tx.revokeSessionsBeyondLimit("user-1", 4, revokedAt);
      return { byRefresh, byAccess };
    });

    expect(found.byRefresh?.id).toBe("session-3");
    expect(found.byAccess?.id).toBe("session-3");
    expect(connection.database.sessions
      .filter((row) => row.revoked_at !== null)
      .map((row) => row.id)).toEqual(["session-1", "session-2"]);
  });

  it("revokes only active sessions for the selected device", async () => {
    const { connection, repository } = createRepository();
    const first = session("session-1", "2030-01-01T00:00:01.000Z");
    const second = session("session-2", "2030-01-01T00:00:02.000Z");
    await repository.transaction(async (tx) => {
      await tx.insertSession(first);
      await tx.insertSession(second);
      await tx.revokeSessionsForDevice(
        "user-1",
        first.deviceIdHash,
        new Date("2030-01-02T00:00:00.000Z")
      );
    });

    expect(connection.database.sessions.map((row) => row.revoked_at !== null))
      .toEqual([true, false]);
  });

  it("supports current-session and all-session revocation", async () => {
    const { connection, repository } = createRepository();
    await repository.transaction(async (tx) => {
      await tx.insertSession(session("session-1", "2030-01-01T00:00:01.000Z"));
      await tx.insertSession(session("session-2", "2030-01-01T00:00:02.000Z"));
      await tx.revokeSession("session-1", new Date("2030-01-02T00:00:00.000Z"));
    });
    expect(connection.database.sessions.map((row) => row.revoked_at !== null))
      .toEqual([true, false]);

    await repository.transaction((tx) =>
      tx.revokeAllSessions("user-1", new Date("2030-01-03T00:00:00.000Z"))
    );
    expect(connection.database.sessions.map((row) => row.revoked_at !== null))
      .toEqual([true, true]);
  });

  it("moves an existing user into the deletion state", async () => {
    const { connection, repository } = createRepository();
    connection.database.users.push({
      id: "user-1",
      status: "ACTIVE",
      created_at: new Date("2030-01-01T00:00:00.000Z"),
      deletion_requested_at: null
    });
    const requestedAt = new Date("2030-01-02T00:00:00.000Z");

    await repository.transaction((tx) => tx.markUserDeleting("user-1", requestedAt));

    expect(connection.database.users[0]).toMatchObject({
      status: "DELETING",
      deletion_requested_at: requestedAt
    });
  });

  it("rolls back all identity writes when transactional work fails", async () => {
    const { connection, repository } = createRepository();

    await expect(repository.transaction(async (tx) => {
      await tx.insertSession(session("session-1", "2030-01-01T00:00:00.000Z"));
      throw new Error("APPLICATION_WRITE_FAILED");
    })).rejects.toThrow("APPLICATION_WRITE_FAILED");

    expect(connection.database.sessions).toEqual([]);
    expect(connection.events).toEqual(["begin", "rollback", "release"]);
  });
});
