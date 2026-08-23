import type { Pool, RowDataPacket } from "mysql2/promise";
import type { PortraitAsset, PortraitAssetReader } from "../ports/portrait-asset-reader.js";

interface PortraitAssetRow extends RowDataPacket {
  asset_id: string;
  user_id: string;
  upload_session_id: string;
  object_key: string;
  width: number | string;
  height: number | string;
  quality_warning: number | boolean;
}

export class MySqlPortraitAssetReader implements PortraitAssetReader {
  public constructor(private readonly pool: Pool) {}

  public async findApprovedNormalized(
    userId: string,
    assetId: string
  ): Promise<PortraitAsset | undefined> {
    const [rows] = await this.pool.execute<PortraitAssetRow[]>(
      `SELECT a.id AS asset_id, a.user_id, a.upload_session_id,
              a.object_key, a.width, a.height, u.quality_warning
       FROM assets a
       INNER JOIN upload_sessions u
       WHERE a.id = ? AND a.user_id = ? AND a.kind = 'NORMALIZED'
         AND u.state = 'APPROVED' AND u.id = a.upload_session_id
       LIMIT 1`,
      [assetId, userId]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      assetId: row.asset_id,
      userId: row.user_id,
      uploadSessionId: row.upload_session_id,
      objectKey: row.object_key,
      width: Number(row.width),
      height: Number(row.height),
      qualityWarning: Boolean(row.quality_warning)
    };
  }
}
