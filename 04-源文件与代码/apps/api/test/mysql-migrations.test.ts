import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  withTransaction,
  type TransactionPool
} from "../src/infrastructure/mysql.js";

const migrationSql = readFileSync(
  fileURLToPath(new URL("../migrations/001_identity.sql", import.meta.url)),
  "utf8"
);

class SchemaRecordingMySql {
  public readonly tables = new Map<string, string>();
  public readonly schemaChanges: string[] = [];

  public runMigration(sql: string): void {
    for (const statement of sql.split(";")) {
      const createTable = statement.match(
        /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?(\w+)`?\s*\(/i
      );
      if (!createTable?.[1]) {
        continue;
      }

      const tableName = createTable[1];
      if (!this.tables.has(tableName)) {
        const definition = statement.replace(/\s+/g, " ").trim();
        this.tables.set(tableName, definition);
        this.schemaChanges.push(tableName);
      }
    }
  }
}

class RecordingConnection {
  public readonly events: string[] = [];

  public async beginTransaction(): Promise<void> {
    this.events.push("begin");
  }

  public async commit(): Promise<void> {
    this.events.push("commit");
  }

  public async rollback(): Promise<void> {
    this.events.push("rollback");
  }

  public release(): void {
    this.events.push("release");
  }
}

describe("001_identity migration", () => {
  it("creates the required identity schema once and leaves it unchanged on a second run", () => {
    const mysql = new SchemaRecordingMySql();

    mysql.runMigration(migrationSql);
    expect(mysql.schemaChanges).toEqual([
      "users",
      "identity_bindings",
      "consents",
      "sessions"
    ]);
    expect(mysql.tables.get("identity_bindings")).toContain(
      "UNIQUE KEY uq_identity_app_openid (app_id, openid_lookup_hash)"
    );
    expect(mysql.tables.get("sessions")).toContain("UNIQUE KEY uq_access_hash (access_token_hash)");
    expect(mysql.tables.get("sessions")).toContain("UNIQUE KEY uq_refresh_hash (refresh_token_hash)");

    mysql.schemaChanges.length = 0;
    mysql.runMigration(migrationSql);
    expect(mysql.schemaChanges).toEqual([]);
  });
});

describe("withTransaction", () => {
  it("commits successful work before releasing its connection", async () => {
    const connection = new RecordingConnection();
    const pool = { getConnection: async () => connection } as unknown as TransactionPool;

    const result = await withTransaction(pool, async (transaction) => {
      expect(transaction).toBe(connection);
      connection.events.push("work");
      return "created-user";
    });

    expect(result).toBe("created-user");
    expect(connection.events).toEqual(["begin", "work", "commit", "release"]);
  });

  it("rolls back failed work and still releases its connection", async () => {
    const connection = new RecordingConnection();
    const pool = { getConnection: async () => connection } as unknown as TransactionPool;

    await expect(
      withTransaction(pool, async () => {
        connection.events.push("work");
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");

    expect(connection.events).toEqual(["begin", "work", "rollback", "release"]);
  });
});
