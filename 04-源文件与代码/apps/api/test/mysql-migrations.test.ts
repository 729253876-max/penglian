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

interface ColumnDefinition {
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

interface TableDefinition {
  columns: Record<string, ColumnDefinition>;
  uniqueKeys: Record<string, string[]>;
}

const expectedSchema: Record<string, TableDefinition> = {
  users: {
    columns: {
      id: { type: "CHAR(36)", nullable: false, primaryKey: true },
      status: {
        type: "ENUM('ACTIVE','DELETING','DELETED')",
        nullable: false,
        primaryKey: false
      },
      created_at: { type: "DATETIME(3)", nullable: false, primaryKey: false },
      deletion_requested_at: { type: "DATETIME(3)", nullable: true, primaryKey: false }
    },
    uniqueKeys: {}
  },
  identity_bindings: {
    columns: {
      id: { type: "CHAR(36)", nullable: false, primaryKey: true },
      user_id: { type: "CHAR(36)", nullable: false, primaryKey: false },
      app_id: { type: "VARCHAR(64)", nullable: false, primaryKey: false },
      openid_ciphertext: { type: "VARBINARY(512)", nullable: false, primaryKey: false },
      openid_lookup_hash: { type: "BINARY(32)", nullable: false, primaryKey: false },
      created_at: { type: "DATETIME(3)", nullable: false, primaryKey: false }
    },
    uniqueKeys: {
      uq_identity_app_openid: ["app_id", "openid_lookup_hash"]
    }
  },
  consents: {
    columns: {
      id: { type: "CHAR(36)", nullable: false, primaryKey: true },
      user_id: { type: "CHAR(36)", nullable: false, primaryKey: false },
      consent_type: { type: "VARCHAR(64)", nullable: false, primaryKey: false },
      policy_version: { type: "VARCHAR(64)", nullable: false, primaryKey: false },
      granted: { type: "BOOLEAN", nullable: false, primaryKey: false },
      granted_at: { type: "DATETIME(3)", nullable: false, primaryKey: false },
      revoked_at: { type: "DATETIME(3)", nullable: true, primaryKey: false }
    },
    uniqueKeys: {}
  },
  sessions: {
    columns: {
      id: { type: "CHAR(36)", nullable: false, primaryKey: true },
      user_id: { type: "CHAR(36)", nullable: false, primaryKey: false },
      device_id_hash: { type: "BINARY(32)", nullable: false, primaryKey: false },
      access_token_hash: { type: "BINARY(32)", nullable: false, primaryKey: false },
      access_expires_at: { type: "DATETIME(3)", nullable: false, primaryKey: false },
      refresh_token_hash: { type: "BINARY(32)", nullable: false, primaryKey: false },
      refresh_expires_at: { type: "DATETIME(3)", nullable: false, primaryKey: false },
      last_used_at: { type: "DATETIME(3)", nullable: false, primaryKey: false },
      revoked_at: { type: "DATETIME(3)", nullable: true, primaryKey: false }
    },
    uniqueKeys: {
      uq_access_hash: ["access_token_hash"],
      uq_refresh_hash: ["refresh_token_hash"]
    }
  }
};

class StrictSchemaRecordingMySql {
  public readonly tables = new Map<string, TableDefinition>();
  public readonly schemaChanges: string[] = [];

  public runMigration(sql: string): void {
    const statements = sql.split(";");
    if (statements.pop()?.trim() !== "") {
      throw new Error("MIGRATION_MISSING_FINAL_SEMICOLON");
    }

    for (const rawStatement of statements) {
      const statement = rawStatement.trim();
      if (!statement) {
        throw new Error("EMPTY_MIGRATION_STATEMENT");
      }
      const { tableName, definition } = this.parseCreateTable(statement);
      if (!this.tables.has(tableName)) {
        this.tables.set(tableName, definition);
        this.schemaChanges.push(tableName);
      }
    }
  }

  private parseCreateTable(statement: string): {
    tableName: string;
    definition: TableDefinition;
  } {
    const table = statement.match(
      /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)\s*\(([\s\S]+)\)$/
    );
    if (!table?.[1] || !table[2]) {
      throw new Error(`UNRECOGNIZED_MIGRATION_STATEMENT: ${statement}`);
    }

    const columns: Record<string, ColumnDefinition> = {};
    const uniqueKeys: Record<string, string[]> = {};
    for (const part of splitTopLevelCommaSeparated(table[2])) {
      const column = part.match(
        /^(\w+)\s+(CHAR\(36\)|VARCHAR\(64\)|VARBINARY\(512\)|BINARY\(32\)|DATETIME\(3\)|BOOLEAN|ENUM\('ACTIVE','DELETING','DELETED'\))\s+(PRIMARY KEY|NOT NULL|NULL)$/
      );
      if (column?.[1] && column[2] && column[3]) {
        if (columns[column[1]]) {
          throw new Error(`DUPLICATE_COLUMN: ${column[1]}`);
        }
        columns[column[1]] = {
          type: column[2],
          nullable: column[3] === "NULL",
          primaryKey: column[3] === "PRIMARY KEY"
        };
        continue;
      }

      const uniqueKey = part.match(/^UNIQUE KEY (\w+) \((\w+(?:, \w+)*)\)$/);
      if (uniqueKey?.[1] && uniqueKey[2]) {
        if (uniqueKeys[uniqueKey[1]]) {
          throw new Error(`DUPLICATE_UNIQUE_KEY: ${uniqueKey[1]}`);
        }
        uniqueKeys[uniqueKey[1]] = uniqueKey[2].split(", ");
        continue;
      }

      throw new Error(`UNRECOGNIZED_TABLE_DEFINITION: ${part}`);
    }

    return { tableName: table[1], definition: { columns, uniqueKeys } };
  }
}

function splitTopLevelCommaSeparated(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote = false;

  for (const character of input) {
    if (character === "'") {
      inQuote = !inQuote;
    } else if (!inQuote && character === "(") {
      depth += 1;
    } else if (!inQuote && character === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new Error("UNBALANCED_PARENTHESIS");
      }
    }

    if (!inQuote && depth === 0 && character === ",") {
      if (!current.trim()) {
        throw new Error("EMPTY_TABLE_DEFINITION");
      }
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (inQuote || depth !== 0 || !current.trim()) {
    throw new Error("MALFORMED_TABLE_DEFINITION_LIST");
  }
  parts.push(current.trim());
  return parts;
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
  it("creates the complete required identity schema once and leaves it unchanged on a second run", () => {
    const mysql = new StrictSchemaRecordingMySql();

    mysql.runMigration(migrationSql);
    expect(mysql.schemaChanges).toEqual([
      "users",
      "identity_bindings",
      "consents",
      "sessions"
    ]);
    expect(Object.fromEntries(mysql.tables)).toEqual(expectedSchema);

    mysql.schemaChanges.length = 0;
    mysql.runMigration(migrationSql);
    expect(mysql.schemaChanges).toEqual([]);
  });

  it("rejects unknown SQL instead of silently skipping it", () => {
    const mysql = new StrictSchemaRecordingMySql();

    expect(() => mysql.runMigration("ALTER TABLE users ADD COLUMN ignored BOOLEAN;"))
      .toThrow("UNRECOGNIZED_MIGRATION_STATEMENT");
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
