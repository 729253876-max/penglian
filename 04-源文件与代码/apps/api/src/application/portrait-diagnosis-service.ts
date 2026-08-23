import type {
  PortraitFinding,
  PortraitProtection
} from "@photo-ai/contracts";
import type { PortraitAsset } from "../ports/portrait-asset-reader.js";

export interface PortraitDiagnosis {
  findings: PortraitFinding[];
  protections: PortraitProtection[];
}

export interface PortraitDiagnosisService {
  diagnose(asset: PortraitAsset): Promise<PortraitDiagnosis>;
}

const protections: PortraitProtection[] = [
  "IDENTITY",
  "FACIAL_STRUCTURE",
  "HAIR",
  "CLOTHING",
  "POSE",
  "SUBJECT_COUNT",
  "COMPOSITION"
];

export class DeterministicPortraitDiagnosisService
implements PortraitDiagnosisService {
  public async diagnose(asset: PortraitAsset): Promise<PortraitDiagnosis> {
    return {
      findings: asset.qualityWarning ? ["LIGHT_NOISE", "LIGHT_BLUR"] : [],
      protections: [...protections]
    };
  }
}
