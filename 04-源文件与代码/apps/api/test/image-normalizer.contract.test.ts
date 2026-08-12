import { describe, expect, it } from "vitest";
import { MockImageNormalizer } from "../src/infrastructure/mock-image-normalizer.js";

const input = {
  sessionId: "session-1",
  sourceObjectKey: "users/user-1/uploads/session-1/original",
  normalizedObjectKey: "users/user-1/uploads/session-1/normalized",
  auditObjectKey: "users/user-1/uploads/session-1/audit"
};

describe("image normalizer contract", () => {
  it.each([
    ["jpeg", "JPEG"],
    ["png-transparent", "PNG"],
    ["heif", "HEIF"]
  ] as const)("normalizes decoded %s input to sRGB without metadata", async (fixture, format) => {
    const normalizer = new MockImageNormalizer(fixture);
    const result = await normalizer.inspectAndNormalize(input);

    expect(result.format).toBe(format);
    expect(result.normalized).toMatchObject({
      objectKey: input.normalizedObjectKey,
      colorSpace: "sRGB",
      metadataRemoved: true
    });
    expect(result.audit.objectKey).toBe(input.auditObjectKey);
    expect(Math.max(result.audit.width, result.audit.height)).toBeLessThanOrEqual(10_000);
    if (fixture === "png-transparent") expect(result.normalized.hasAlpha).toBe(true);
  });

  it.each([
    ["corrupt", "IMAGE_DECODE_FAILED"],
    ["mime-spoof", "IMAGE_FORMAT_MISMATCH"],
    ["animated", "ANIMATED_IMAGE_UNSUPPORTED"],
    ["pixel-overflow", "IMAGE_PIXEL_COUNT_EXCEEDED"],
    ["long-edge-overflow", "IMAGE_LONG_EDGE_EXCEEDED"]
  ] as const)("rejects decoded %s input", async (fixture, code) => {
    const normalizer = new MockImageNormalizer(fixture);
    await expect(normalizer.inspectAndNormalize(input)).rejects.toThrow(code);
  });
});
