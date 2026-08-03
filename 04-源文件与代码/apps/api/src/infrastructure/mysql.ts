import type { Pool, PoolConnection } from "mysql2/promise";

export type TransactionPool = Pick<Pool, "getConnection">;

export async function withTransaction<T>(
  pool: TransactionPool,
  work: (connection: PoolConnection) => Promise<T>
): Promise<T> {
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
    throw error;
  } finally {
    connection.release();
  }
}
