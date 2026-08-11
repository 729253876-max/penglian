import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import {
  createPool,
  type Pool,
  type RowDataPacket
} from "mysql2/promise";
import { IdentityService } from "../src/application/identity-service.js";
import { digestToken } from "../src/domain/session-token.js";
import { MySqlIdentityRepository } from "../src/infrastructure/mysql-identity-repository.js";

const safeDatabasePattern = /^photo_ai_b1_test(?:_[a-z0-9][a-z0-9_]*)?$/;
const identityTables = [
  "users",
  "identity_bindings",
  "consents",
  "sessions"
] as const;
const migrationSql = readFileSync(
  fileURLToPath(new URL("../migrations/001_identity.sql", import.meta.url)),
  "utf8"
);

type IntegrationConfiguration =
  | { ready: false; reason: string }
  | { ready: true; connectionUri: string };

interface CountRow extends RowDataPacket {
  count: number;
}

interface VersionRow extends RowDataPacket {
  version: string;
}

interface TableNameRow extends RowDataPacket {
  tableName: string;
}

interface SessionStateRow extends RowDataPacket {
  deviceIdHash: Buffer;
  revokedAt: Date | string | null;
}

class MutableClock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

const integrationConfiguration = loadIntegrationConfiguration(process.env);
if (!integrationConfiguration.ready) {
  console.warn(
    `[B1 MySQL integration] NOT ACCEPTED; skipped: ${integrationConfiguration.reason}`
  );
}

describe(
  "MySQL 8 identity integration (serial, destructive only inside a guarded test database)",
  { sequential: true, skip: !integrationConfiguration.ready },
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createIntegrationPool();
      const [versionRows] = await pool.query<VersionRow[]>(
        "SELECT VERSION() AS version"
      );
      expect(versionRows[0]?.version).toMatch(/^8\./);
      await applyProductionMigration(pool);
      await cleanIdentityTables(pool);
    });

    beforeEach(async () => {
      await cleanIdentityTables(pool);
    });

    afterEach(async () => {
      await cleanIdentityTables(pool);
    });

    afterAll(async () => {
      await cleanIdentityTables(pool);
      await pool.end();
    });

    it("applies the production migration idempotently on MySQL 8", async () => {
      await applyProductionMigration(pool);

      const [rows] = await pool.query<TableNameRow[]>(
        `SELECT table_name AS tableName
         FROM information_schema.tables
         WHERE table_schema = DATABASE()
           AND table_name IN ('users', 'identity_bindings', 'consents', 'sessions')`
      );

      expect(rows.map(({ tableName }) => tableName).sort())
        .toEqual([...identityTables].sort());
    });

    it("maps concurrent and repeated login for one OpenID to exactly one user", async () => {
      const service = createIdentityService(pool);

      await Promise.all([
        login(service, "openid-concurrent", "device-concurrent-1"),
        login(service, "openid-concurrent", "device-concurrent-2")
      ]);
      await login(service, "openid-concurrent", "device-repeated");

      expect(await countRows(pool, "users")).toBe(1);
      expect(await countRows(pool, "identity_bindings")).toBe(1);
    });

    it("allows exactly one winner for two concurrent refreshes", async () => {
      const service = createIdentityService(pool);
      const initial = await login(service, "openid-refresh", "device-refresh");

      const results = await Promise.allSettled([
        service.refresh({
          refreshToken: initial.refreshToken,
          deviceId: "device-refresh"
        }),
        service.refresh({
          refreshToken: initial.refreshToken,
          deviceId: "device-refresh"
        })
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ message: "SESSION_REVOKED" });
      expect(await countActiveSessions(pool)).toBe(1);
    });

    it("revokes the oldest session when a sixth device logs in", async () => {
      const clock = new MutableClock(new Date("2030-01-02T03:04:05.000Z"));
      const service = createIdentityService(pool, clock);

      for (let index = 1; index <= 6; index += 1) {
        await login(service, "openid-six-devices", `device-${index}`);
        clock.advance(1_000);
      }

      const [rows] = await pool.query<SessionStateRow[]>(
        `SELECT device_id_hash AS deviceIdHash, revoked_at AS revokedAt
         FROM sessions`
      );
      const states = new Map(
        rows.map((row) => [row.deviceIdHash.toString("hex"), row.revokedAt])
      );

      expect(rows).toHaveLength(6);
      expect(states.get(digestToken("device-1").toString("hex")))
        .not.toBeNull();
      for (let index = 2; index <= 6; index += 1) {
        expect(states.get(digestToken(`device-${index}`).toString("hex")))
          .toBeNull();
      }
    });

    it("keeps an active session usable after closing and recreating the pool", async () => {
      const service = createIdentityService(pool);
      const initial = await login(service, "openid-restart", "device-restart");

      pool = await restartPool(pool);
      const restartedService = createIdentityService(pool);
      const refreshed = await restartedService.refresh({
        refreshToken: initial.refreshToken,
        deviceId: "device-restart"
      });

      expect(refreshed.refreshToken).not.toBe(initial.refreshToken);
      expect(await countActiveSessions(pool)).toBe(1);
    });

    it("continues to reject a revoked session after closing and recreating the pool", async () => {
      const service = createIdentityService(pool);
      const initial = await login(
        service,
        "openid-revoked-restart",
        "device-revoked-restart"
      );
      await service.logoutCurrent(initial.accessToken);

      pool = await restartPool(pool);
      const restartedService = createIdentityService(pool);

      await expect(restartedService.refresh({
        refreshToken: initial.refreshToken,
        deviceId: "device-revoked-restart"
      })).rejects.toThrow("SESSION_REVOKED");
      expect(await countActiveSessions(pool)).toBe(0);
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

  if (parsed.protocol !== "mysql:" || !parsed.hostname) {
    throw new Error("MYSQL_INTEGRATION_REFUSED_INVALID_URL");
  }
  if (!safeDatabasePattern.test(databaseName)) {
    throw new Error("MYSQL_INTEGRATION_REFUSED_UNSAFE_DATABASE");
  }

  return { ready: true, connectionUri };
}

function createIntegrationPool(): Pool {
  if (!integrationConfiguration.ready) {
    throw new Error("MYSQL_INTEGRATION_NOT_CONFIGURED");
  }
  return createPool({
    uri: integrationConfiguration.connectionUri,
    connectionLimit: 10,
    waitForConnections: true,
    timezone: "Z"
  });
}

async function applyProductionMigration(pool: Pool): Promise<void> {
  const statements = migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function cleanIdentityTables(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM consents");
  await pool.query("DELETE FROM identity_bindings");
  await pool.query("DELETE FROM users");
}

function createIdentityService(
  pool: Pool,
  clock = new MutableClock(new Date("2030-01-02T03:04:05.000Z"))
): IdentityService {
  return new IdentityService(
    new MySqlIdentityRepository(pool),
    {
      wechatAppId: "wx-b1-mysql-integration",
      identityLookupKey: Buffer.alloc(32, 0x51),
      identityEncryptionKey: Buffer.alloc(32, 0x52),
      accessTokenLifetimeMilliseconds: 2 * 60 * 60 * 1000
    },
    clock
  );
}

async function login(
  service: IdentityService,
  openId: string,
  deviceId: string
) {
  return service.login({
    openId,
    deviceId,
    consent: {
      policyVersion: "2026-08-02",
      metadataRemoval: true
    }
  });
}

async function restartPool(pool: Pool): Promise<Pool> {
  await pool.end();
  const restarted = createIntegrationPool();
  await restarted.query("SELECT 1");
  return restarted;
}

async function countRows(pool: Pool, table: typeof identityTables[number]): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(rows[0]?.count ?? 0);
}

async function countActiveSessions(pool: Pool): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(
    "SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL"
  );
  return Number(rows[0]?.count ?? 0);
}
