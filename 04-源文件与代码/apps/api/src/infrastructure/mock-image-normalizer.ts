import { validateDimensions } from "../domain/upload-policy.js";
import type {
  ImageNormalizer,
  NormalizedImage,
  NormalizeInput
} from "../ports/image-normalizer.js";

export type ImageFixture =
  | "jpeg"
  | "png-transparent"
  | "heif"
  | "corrupt"
  | "mime-spoof"
  | "animated"
  | "pixel-overflow"
  | "long-edge-overflow";

export class MockImageNormalizer implements ImageNormalizer {
  public constructor(private readonly fixture: ImageFixture) {}

  public async inspectAndNormalize(input: NormalizeInput): Promise<NormalizedImage> {
    const errorCode = fixtureError(this.fixture);
    if (errorCode) throw new Error(errorCode);

    const source = { width: 4000, height: 3000, pixels: 12_000_000 };
    const { qualityWarning } = validateDimensions(source);
    return {
      format: this.fixture === "jpeg" ? "JPEG" : this.fixture === "heif" ? "HEIF" : "PNG",
      source,
      normalized: {
        objectKey: input.normalizedObjectKey,
        width: source.width,
        height: source.height,
        sizeBytes: 900_000,
        colorSpace: "sRGB",
        metadataRemoved: true,
        hasAlpha: this.fixture === "png-transparent"
      },
      audit: { objectKey: input.auditObjectKey, width: source.width, height: source.height, sizeBytes: 750_000 },
      qualityWarning
    };
  }
}

function fixtureError(fixture: ImageFixture): string | undefined {
  switch (fixture) {
    case "corrupt": return "IMAGE_DECODE_FAILED";
    case "mime-spoof": return "IMAGE_FORMAT_MISMATCH";
    case "animated": return "ANIMATED_IMAGE_UNSUPPORTED";
    case "pixel-overflow": return "IMAGE_PIXEL_COUNT_EXCEEDED";
    case "long-edge-overflow": return "IMAGE_LONG_EDGE_EXCEEDED";
    default: return undefined;
  }
}
