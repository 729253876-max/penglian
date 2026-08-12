import { describe, expect, it } from "vitest";
import { validateDimensions, validateUploadHeader } from "../src/domain/upload-policy.js";

describe("upload policy", () => {
  it("accepts inclusive size and dimension boundaries", () => {
    expect(validateUploadHeader({ fileName: "photo.HEIC", sizeBytes: 30 * 1024 * 1024 }))
      .toEqual({ extension: "heic" });
    expect(validateDimensions({ width: 12_000, height: 256 }))
      .toEqual({ qualityWarning: true });
    expect(validateDimensions({ width: 10_000, height: 5_000 }))
      .toEqual({ qualityWarning: false });
  });

  it("rejects unsupported extensions and exact over-limit values", () => {
    expect(() => validateUploadHeader({ fileName: "photo.gif", sizeBytes: 1024 }))
      .toThrow("IMAGE_FORMAT_UNSUPPORTED");
    expect(() => validateUploadHeader({ fileName: "photo.jpg", sizeBytes: 30 * 1024 * 1024 + 1 }))
      .toThrow("IMAGE_TOO_LARGE");
    expect(() => validateDimensions({ width: 12_001, height: 256 }))
      .toThrow("IMAGE_LONG_EDGE_EXCEEDED");
    expect(() => validateDimensions({ width: 10_000, height: 5_001 }))
      .toThrow("IMAGE_PIXEL_COUNT_EXCEEDED");
    expect(() => validateDimensions({ width: 255, height: 255 }))
      .toThrow("IMAGE_SHORT_EDGE_TOO_SMALL");
  });
});
