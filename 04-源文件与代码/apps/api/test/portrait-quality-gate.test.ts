import { describe, expect, it } from "vitest";
import {
  DeterministicPortraitQualityGate,
  type FidelityCheck
} from "../src/application/portrait-quality-gate.js";

const allChecks: FidelityCheck[] = [
  "FACE_COUNT",
  "IDENTITY",
  "STRUCTURE",
  "NON_TARGET_REGION",
  "ARTIFACTS"
];

describe("DeterministicPortraitQualityGate", () => {
  it("returns only the explicit deterministic fixture result", async () => {
    const gate = new DeterministicPortraitQualityGate({
      passed: false,
      failedChecks: ["IDENTITY", "STRUCTURE"]
    });

    await expect(gate.evaluate({
      candidateAssetId: "candidate-1",
      watermarkedPreviewUrl: "https://example.invalid/preview.jpg",
      direction: "NATURAL_RESCUE"
    })).resolves.toEqual({
      passed: false,
      checks: allChecks,
      failedChecks: ["IDENTITY", "STRUCTURE"]
    });
  });
});
