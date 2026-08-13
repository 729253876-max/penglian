import { describe, expect, it } from "vitest";
import { UnavailableImageProvider } from "../src/infrastructure/unavailable-image-provider.js";

describe("UnavailableImageProvider", () => {
  it("rejects without creating a candidate, preview URL, or provider receipt", async () => {
    const provider = new UnavailableImageProvider();

    await expect(provider.runPreview({
      tool: "PORTRAIT_RETOUCH",
      inputAssetId: "approved-asset",
      direction: "NATURAL_RESCUE",
      parameters: { naturalness: 85, detailLevel: 35 }
    }, 1)).rejects.toThrow("IMAGE_PROVIDER_NOT_CONFIGURED");
  });
});
