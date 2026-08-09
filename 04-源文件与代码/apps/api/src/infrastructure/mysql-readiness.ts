export interface ReadinessDatabase {
  query(options: { sql: string; timeout: number }): Promise<unknown>;
}

export function createMySqlReadiness(
  database: ReadinessDatabase,
  timeoutMilliseconds = 1500
) {
  return {
    check: async () => {
      await database.query({ sql: "SELECT 1", timeout: timeoutMilliseconds });
    }
  };
}
