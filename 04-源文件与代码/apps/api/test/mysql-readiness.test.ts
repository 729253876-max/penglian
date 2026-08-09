import { describe, expect, it } from "vitest";
import { createMySqlReadiness } from "../src/infrastructure/mysql-readiness.js";

describe("MySQL readiness", () => {
  it("passes a bounded timeout to the MySQL readiness query", async () => {
    const calls: unknown[] = [];
    const readiness = createMySqlReadiness({
      query: async (options: unknown) => {
        calls.push(options);
        return [[], []];
      }
    });

    await readiness.check();

    expect(calls).toEqual([{ sql: "SELECT 1", timeout: 1500 }]);
  });
});
