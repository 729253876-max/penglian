import type { ImageNormalizer, NormalizedImage } from "../ports/image-normalizer.js";
import type { ObjectStorage, PrivateObjectMetadata } from "../ports/object-storage.js";

interface AcceptUploadedObjectInput {
  sessionId: string;
  userId: string;
  sourceObjectKey: string;
  now: Date;
}

interface NormalizeAcceptedUploadInput extends AcceptUploadedObjectInput {
  normalizedObjectKey: string;
  auditObjectKey: string;
}

export interface UploadFinalizationRepository {
  acceptUploadedObject(input: AcceptUploadedObjectInput & {
    expectedState: "INIT";
    nextState: "UPLOADED";
    source: PrivateObjectMetadata;
    normalizeJobIdempotencyKey: string;
  }): Promise<void>;
  completeNormalization(input: NormalizeAcceptedUploadInput & NormalizedImage & {
    expectedState: "UPLOADED";
    nextState: "REVIEWING";
    moderationJobIdempotencyKey: string;
  }): Promise<void>;
  failNormalization(input: NormalizeAcceptedUploadInput & {
    expectedState: "UPLOADED";
    nextState: "FAILED";
    errorCode: string;
    cleanupJobIdempotencyKey: string;
  }): Promise<void>;
}

export class UploadFinalizationService {
  public constructor(
    private readonly storage: Pick<ObjectStorage, "headPrivateObject">,
    private readonly repository: UploadFinalizationRepository,
    private readonly normalizer?: ImageNormalizer
  ) {}

  public async acceptUploadedObject(input: AcceptUploadedObjectInput): Promise<void> {
    const source = await this.storage.headPrivateObject(input.sourceObjectKey);
    await this.repository.acceptUploadedObject({
      ...input,
      expectedState: "INIT",
      nextState: "UPLOADED",
      source,
      normalizeJobIdempotencyKey: `normalize:${input.sessionId}`
    });
  }

  public async normalizeAcceptedUpload(input: NormalizeAcceptedUploadInput): Promise<void> {
    if (!this.normalizer) throw new Error("IMAGE_NORMALIZER_NOT_CONFIGURED");
    try {
      const result = await this.normalizer.inspectAndNormalize(input);
      await this.repository.completeNormalization({
        ...input,
        ...result,
        expectedState: "UPLOADED",
        nextState: "REVIEWING",
        moderationJobIdempotencyKey: `moderate:${input.sessionId}`
      });
    } catch (error) {
      const errorCode = normalizeErrorCode(error);
      if (!permanentNormalizationErrors.has(errorCode)) throw error;
      await this.repository.failNormalization({
        ...input,
        expectedState: "UPLOADED",
        nextState: "FAILED",
        errorCode,
        cleanupJobIdempotencyKey: `cleanup:${input.sessionId}`
      });
      throw error;
    }
  }
}

const permanentNormalizationErrors = new Set([
  "IMAGE_DECODE_FAILED",
  "IMAGE_FORMAT_MISMATCH",
  "IMAGE_FORMAT_UNSUPPORTED",
  "ANIMATED_IMAGE_UNSUPPORTED",
  "IMAGE_DIMENSIONS_INVALID",
  "IMAGE_SHORT_EDGE_TOO_SMALL",
  "IMAGE_LONG_EDGE_EXCEEDED",
  "IMAGE_PIXEL_COUNT_EXCEEDED"
]);

function normalizeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) {
    return error.message;
  }
  return "IMAGE_NORMALIZATION_FAILED";
}
