import { describe, expect, it } from "vitest";
import { DeterministicPortraitDiagnosisService } from "../src/application/portrait-diagnosis-service.js";

const asset = {
  assetId: "asset-1",
  userId: "user-1",
  uploadSessionId: "upload-1",
  objectKey: "private/object",
  width: 2400,
  height: 3200,
  qualityWarning: true
};

describe("DeterministicPortraitDiagnosisService", () => {
  it("records only conservative quality-warning findings and every fidelity protection", async () => {
    const result = await new DeterministicPortraitDiagnosisService().diagnose(asset);

    expect(result.findings).toEqual(["LIGHT_NOISE", "LIGHT_BLUR"]);
    expect(result.protections).toEqual([
      "IDENTITY",
      "FACIAL_STRUCTURE",
      "HAIR",
      "CLOTHING",
      "POSE",
      "SUBJECT_COUNT",
      "COMPOSITION"
    ]);
  });

  it("does not invent visual findings when metadata has no quality warning", async () => {
    const result = await new DeterministicPortraitDiagnosisService().diagnose({
      ...asset,
      qualityWarning: false
    });

    expect(result.findings).toEqual([]);
  });
});
