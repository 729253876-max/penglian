export interface PortraitAsset {
  assetId: string;
  userId: string;
  uploadSessionId: string;
  objectKey: string;
  width: number;
  height: number;
  qualityWarning: boolean;
}

export interface PortraitAssetReader {
  findApprovedNormalized(userId: string, assetId: string): Promise<PortraitAsset | undefined>;
}
