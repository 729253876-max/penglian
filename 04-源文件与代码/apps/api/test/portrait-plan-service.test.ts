import { describe, expect, it } from "vitest";
import type { PortraitDiagnosis } from "../src/application/portrait-diagnosis-service.js";
import { PortraitPlanService } from "../src/application/portrait-plan-service.js";

const diagnosis: PortraitDiagnosis = {
  findings: ["LIGHT_NOISE", "LIGHT_BLUR"],
  protections: [
    "IDENTITY",
    "FACIAL_STRUCTURE",
    "HAIR",
    "CLOTHING",
    "POSE",
    "SUBJECT_COUNT",
    "COMPOSITION"
  ]
};

describe("PortraitPlanService", () => {
  it.each([
    ["NATURAL_RESCUE" as const, 85, 35],
    ["CLEAR_RESCUE" as const, 75, 60]
  ])("keeps %s inside the same protection boundary", (direction, naturalness, detailLevel) => {
    const plan = new PortraitPlanService().plan(diagnosis, direction);

    expect(plan).toMatchObject({
      direction,
      naturalness,
      detailLevel,
      protections: diagnosis.protections
    });
    expect(plan.forbiddenOperations).toEqual([
      "FACE_SWAP",
      "FACE_RESHAPE",
      "BODY_RESHAPE",
      "MAKEUP_GENERATION",
      "BACKGROUND_REPLACE"
    ]);
  });
});
