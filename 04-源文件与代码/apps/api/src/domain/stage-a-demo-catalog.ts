import type { CreateTaskInput } from "@photo-ai/contracts";

export type PortraitTaskInput = Extract<
  CreateTaskInput,
  { tool: "PORTRAIT_RETOUCH" }
>;

export interface StageADemoProfile {
  readonly profileId: "portrait-natural-v1";
  readonly inputAssetId: "demo-portrait-001";
  readonly direction: "NATURAL";
  readonly parameters: {
    readonly brightness: 0;
    readonly warmth: 0;
    readonly naturalness: 80;
  };
  readonly diagnosis: {
    readonly copyKey: "portrait.diagnosis.light";
    readonly finding: "FACE_SHADOW_AND_BACKGROUND_HIGHLIGHT";
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
  direction: "NATURAL",
  parameters: {
    brightness: 0,
    warmth: 0,
    naturalness: 80
  },
  diagnosis: {
    copyKey: "portrait.diagnosis.light",
    finding: "FACE_SHADOW_AND_BACKGROUND_HIGHLIGHT"
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
    candidate.parameters.brightness === input.parameters.brightness &&
    candidate.parameters.warmth === input.parameters.warmth &&
    candidate.parameters.naturalness === input.parameters.naturalness
  );

  if (!profile) {
    throw new Error("STAGE_A_UNSUPPORTED_DEMO_INPUT");
  }

  return profile;
}
