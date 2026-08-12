import type { CreateTaskInput } from "@photo-ai/contracts";

export type PortraitTaskInput = Extract<
  CreateTaskInput,
  { tool: "PORTRAIT_RETOUCH" }
>;

export interface StageADemoProfile {
  readonly profileId: "portrait-natural-v1";
  readonly inputAssetId: "demo-portrait-001";
  readonly direction: "NATURAL_RESCUE";
  readonly parameters: {
    readonly naturalness: 85;
    readonly detailLevel: 35;
  };
  readonly diagnosis: {
    readonly copyKey: "portrait.diagnosis.light";
    readonly finding: "FACE_UNDEREXPOSED";
  };
  readonly plan: {
    readonly copyKey: "portrait.plan.natural";
  };
  readonly preview: {
    readonly url: "https://example.invalid/demo-preview/portrait-natural.jpg";
  };
}

const stageADemoProfiles: readonly StageADemoProfile[] = [{
  profileId: "portrait-natural-v1",
  inputAssetId: "demo-portrait-001",
  direction: "NATURAL_RESCUE",
  parameters: {
    naturalness: 85,
    detailLevel: 35
  },
  diagnosis: {
    copyKey: "portrait.diagnosis.light",
    finding: "FACE_UNDEREXPOSED"
  },
  plan: {
    copyKey: "portrait.plan.natural"
  },
  preview: {
    url: "https://example.invalid/demo-preview/portrait-natural.jpg"
  }
}];

export function requireStageADemoProfile(
  input: PortraitTaskInput
): StageADemoProfile {
  const profile = stageADemoProfiles.find((candidate) =>
    candidate.inputAssetId === input.inputAssetId &&
    candidate.direction === input.direction &&
    candidate.parameters.naturalness === input.parameters.naturalness &&
    candidate.parameters.detailLevel === input.parameters.detailLevel
  );

  if (!profile) {
    throw new Error("STAGE_A_UNSUPPORTED_DEMO_INPUT");
  }

  return profile;
}
