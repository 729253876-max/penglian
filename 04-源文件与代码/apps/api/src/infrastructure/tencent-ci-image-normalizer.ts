import type {
  ImageNormalizer,
  NormalizedImage,
  NormalizeInput
} from "../ports/image-normalizer.js";

export interface TencentCiClient {
  inspectAndNormalizePrivateObject(input: NormalizeInput): Promise<NormalizedImage>;
}

export class TencentCiImageNormalizer implements ImageNormalizer {
  public constructor(private readonly client?: TencentCiClient) {}

  public async inspectAndNormalize(input: NormalizeInput): Promise<NormalizedImage> {
    if (!this.client) throw new Error("TENCENT_CI_CREDENTIALS_NOT_APPROVED");
    return this.client.inspectAndNormalizePrivateObject(input);
  }
}
