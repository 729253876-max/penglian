export const uploadPolicy = {
  maxBytes: 30 * 1024 * 1024,
  minShortEdge: 256,
  maxLongEdge: 12_000,
  maxPixels: 50_000_000,
  qualityWarningShortEdge: 1_024,
  sessionTtlMs: 30 * 60_000,
  credentialTtlSeconds: 10 * 60,
  maxCredentialIssues: 2
} as const;

const acceptedExtensions = new Set(["jpg", "jpeg", "png", "heic", "heif"]);

export function validateUploadHeader(input: {
  fileName: string;
  sizeBytes: number;
}): { extension: string } {
  const extension = input.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!acceptedExtensions.has(extension)) {
    throw new Error("IMAGE_FORMAT_UNSUPPORTED");
  }
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > uploadPolicy.maxBytes
  ) {
    throw new Error("IMAGE_TOO_LARGE");
  }
  return { extension };
}

export function validateDimensions(input: {
  width: number;
  height: number;
}): { qualityWarning: boolean } {
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    throw new Error("IMAGE_DIMENSIONS_INVALID");
  }
  const shortEdge = Math.min(input.width, input.height);
  const longEdge = Math.max(input.width, input.height);
  if (shortEdge < uploadPolicy.minShortEdge) {
    throw new Error("IMAGE_SHORT_EDGE_TOO_SMALL");
  }
  if (longEdge > uploadPolicy.maxLongEdge) {
    throw new Error("IMAGE_LONG_EDGE_EXCEEDED");
  }
  if (input.width * input.height > uploadPolicy.maxPixels) {
    throw new Error("IMAGE_PIXEL_COUNT_EXCEEDED");
  }
  return { qualityWarning: shortEdge < uploadPolicy.qualityWarningShortEdge };
}
