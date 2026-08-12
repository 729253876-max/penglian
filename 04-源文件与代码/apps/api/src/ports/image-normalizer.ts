export interface NormalizeInput {
  sessionId: string;
  sourceObjectKey: string;
  normalizedObjectKey: string;
  auditObjectKey: string;
}

export interface NormalizedImage {
  format: "JPEG" | "PNG" | "HEIF";
  source: { width: number; height: number; pixels: number };
  normalized: {
    objectKey: string;
    width: number;
    height: number;
    sizeBytes: number;
    colorSpace: "sRGB";
    metadataRemoved: true;
    hasAlpha: boolean;
  };
  audit: { objectKey: string; width: number; height: number; sizeBytes: number };
  qualityWarning: boolean;
}

export interface ImageNormalizer {
  inspectAndNormalize(input: NormalizeInput): Promise<NormalizedImage>;
}
