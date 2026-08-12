import type {
  PortraitPlanDirection,
  PortraitProtection
} from "@photo-ai/contracts";
import type { PortraitDiagnosis } from "./portrait-diagnosis-service.js";

export type ForbiddenPortraitOperation =
  | "FACE_SWAP"
  | "FACE_RESHAPE"
  | "BODY_RESHAPE"
  | "MAKEUP_GENERATION"
  | "BACKGROUND_REPLACE";

export interface PortraitPlan {
  direction: PortraitPlanDirection;
  naturalness: number;
  detailLevel: number;
  protections: PortraitProtection[];
  forbiddenOperations: ForbiddenPortraitOperation[];
}

const parameters = {
  NATURAL_RESCUE: { naturalness: 85, detailLevel: 35 },
  CLEAR_RESCUE: { naturalness: 75, detailLevel: 60 }
} as const;

const forbiddenOperations: ForbiddenPortraitOperation[] = [
  "FACE_SWAP",
  "FACE_RESHAPE",
  "BODY_RESHAPE",
  "MAKEUP_GENERATION",
  "BACKGROUND_REPLACE"
];

export class PortraitPlanService {
  public plan(
    diagnosis: PortraitDiagnosis,
    direction: PortraitPlanDirection
  ): PortraitPlan {
    return {
      direction,
      ...parameters[direction],
      protections: [...diagnosis.protections],
      forbiddenOperations: [...forbiddenOperations]
    };
  }
}
