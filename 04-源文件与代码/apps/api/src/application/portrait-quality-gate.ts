import type { CreateTaskInput } from "@photo-ai/contracts";

export type FidelityCheck =
  | "FACE_COUNT"
  | "IDENTITY"
  | "STRUCTURE"
  | "NON_TARGET_REGION"
  | "ARTIFACTS";

export type QualityGateResult =
  | { passed: true; checks: FidelityCheck[] }
  | { passed: false; checks: FidelityCheck[]; failedChecks: FidelityCheck[] };

export interface PortraitQualityGateInput {
  candidateAssetId: string;
  watermarkedPreviewUrl: string;
  direction: Extract<CreateTaskInput, { tool: "PORTRAIT_RETOUCH" }>["direction"];
}

export interface PortraitQualityGate {
  evaluate(input: PortraitQualityGateInput): Promise<QualityGateResult>;
}

const fidelityChecks: FidelityCheck[] = [
  "FACE_COUNT",
  "IDENTITY",
  "STRUCTURE",
  "NON_TARGET_REGION",
  "ARTIFACTS"
];

export class DeterministicPortraitQualityGate implements PortraitQualityGate {
  public constructor(
    private readonly fixture:
      | { passed: true }
      | { passed: false; failedChecks: FidelityCheck[] }
  ) {}

  public async evaluate(_input: PortraitQualityGateInput): Promise<QualityGateResult> {
    return this.fixture.passed
      ? { passed: true, checks: [...fidelityChecks] }
      : {
          passed: false,
          checks: [...fidelityChecks],
          failedChecks: [...this.fixture.failedChecks]
        };
  }
}

export class FailClosedPortraitQualityGate implements PortraitQualityGate {
  public async evaluate(_input: PortraitQualityGateInput): Promise<QualityGateResult> {
    return {
      passed: false,
      checks: [...fidelityChecks],
      failedChecks: [...fidelityChecks]
    };
  }
}
