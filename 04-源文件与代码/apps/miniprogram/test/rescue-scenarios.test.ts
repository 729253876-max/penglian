import { expect, it } from "vitest";
import { rescueScenarios } from "../miniprogram/services/rescue-scenarios";

it("keeps one enabled rescue scenario while preserving all four V1 tools", () => {
  expect(rescueScenarios.map((item) => item.tool)).toEqual([
    "PORTRAIT_RETOUCH",
    "QUALITY_ENHANCE",
    "OBJECT_REMOVAL",
    "OLD_PHOTO_RESTORE"
  ]);
  expect(rescueScenarios.filter((item) => item.availableInDemo)).toHaveLength(1);
});
