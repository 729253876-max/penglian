import { describe, expect, it } from "vitest";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { MySqlPortraitAssetReader } from "../src/infrastructure/mysql-portrait-asset-reader.js";

const approvedNormalizedRow = {
  asset_id: "22222222-2222-4222-8222-222222222222",
  user_id: "user-1",
  upload_session_id: "11111111-1111-4111-8111-111111111111",
  object_key: "users/user-1/uploads/11111111-1111-4111-8111-111111111111/normalized",
  width: 3000,
  height: 2000,
  quality_warning: 1,
  kind: "NORMALIZED",
  state: "APPROVED"
};

describe("MySqlPortraitAssetReader", () => {
  it("finds only an approved normalized asset owned by the caller", async () => {
    const { pool, statements } = fakePool([approvedNormalizedRow]);
    const reader = new MySqlPortraitAssetReader(pool);

    await expect(reader.findApprovedNormalized("user-1", approvedNormalizedRow.asset_id))
      .resolves.toEqual({
        assetId: approvedNormalizedRow.asset_id,
        userId: "user-1",
        uploadSessionId: approvedNormalizedRow.upload_session_id,
        objectKey: approvedNormalizedRow.object_key,
        width: 3000,
        height: 2000,
        qualityWarning: true
      });
    await expect(reader.findApprovedNormalized("user-2", approvedNormalizedRow.asset_id))
      .resolves.toBeUndefined();

    expect(statements[0]).toMatchObject({
      sql: expect.stringMatching(/WHERE a\.id = \? AND a\.user_id = \? AND a\.kind = 'NORMALIZED' AND u\.state = 'APPROVED' AND u\.id = a\.upload_session_id/),
      values: [approvedNormalizedRow.asset_id, "user-1"]
    });
  });

  it.each([
    ["an audit asset", { ...approvedNormalizedRow, kind: "AUDIT" }],
    ["an unapproved asset", { ...approvedNormalizedRow, state: "REVIEWING" }],
    ["an asset whose session does not match", { ...approvedNormalizedRow, upload_session_id: "other-session" }]
  ])("rejects %s", async (_label, row) => {
    const { pool } = fakePool([row]);
    await expect(new MySqlPortraitAssetReader(pool)
      .findApprovedNormalized("user-1", approvedNormalizedRow.asset_id))
      .resolves.toBeUndefined();
  });
});

function fakePool(seedRows: Array<typeof approvedNormalizedRow>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    execute: async (sql: string, values: unknown[] = []) => {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      statements.push({ sql: normalizedSql, values });
      const [assetId, userId] = values;
      const rows = seedRows.filter((row) =>
        row.asset_id === assetId &&
        row.user_id === userId &&
        row.kind === "NORMALIZED" &&
        row.state === "APPROVED" &&
        row.upload_session_id === approvedNormalizedRow.upload_session_id
      );
      return [rows as RowDataPacket[], []];
    }
  } as unknown as Pool;
  return { pool, statements };
}
