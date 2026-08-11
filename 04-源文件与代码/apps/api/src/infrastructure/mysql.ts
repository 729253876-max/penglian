import type { Pool, PoolConnection } from "mysql2/promise";

export type TransactionPool = Pick<Pool, "getConnection">;

const maxDeadlockAttempts = 3;

export async function withTransaction<T>(
  pool: TransactionPool,
  work: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  for (let attempt = 1; attempt <= maxDeadlockAttempts; attempt += 1) {
    const connection = await pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          // Preserve the original database or work error for the caller.
        }
      }
      if (!isMySqlDeadlock(error) || attempt === maxDeadlockAttempts) {
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  throw new Error("UNREACHABLE_MYSQL_TRANSACTION_STATE");
}

function isMySqlDeadlock(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const mysqlError = error as { code?: unknown; errno?: unknown };
  return mysqlError.code === "ER_LOCK_DEADLOCK" && mysqlError.errno === 1213;
}
