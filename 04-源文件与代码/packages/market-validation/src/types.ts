export type EvaluationTool =
  | "PORTRAIT_RETOUCH"
  | "QUALITY_ENHANCE"
  | "OBJECT_REMOVAL"
  | "OLD_PHOTO_RESTORE";

export interface EvaluationSample {
  sampleId: string;
  tool: EvaluationTool;
  identityApplicable: boolean;
  identityPass: boolean;
  severeDefect: boolean;
  preferredOverOriginal: boolean;
  preferredOverBenchmark: boolean;
  willingToSave: boolean;
  successfulDelivery: boolean;
  inferenceCostYuan: number;
  moderationCostYuan: number;
  retryCostYuan: number;
  storageCostYuan: number;
  bandwidthCostYuan: number;
  paymentFeeYuan: number;
  refundLossYuan: number;
  candidatePriceYuan: number;
}

export interface EvaluationConfig {
  minimumSamplesByTool: Record<EvaluationTool, number>;
  thresholds: {
    identityPassRate: number;
    severeDefectRate: number;
    preferredOverOriginalRate: number;
    preferredOverBenchmarkRate: number;
    willingToSaveRate: number;
  };
}

export interface GateResult {
  id: "COVERAGE" | "IDENTITY" | "SEVERE_DEFECT" | "ORIGINAL_PREFERENCE" |
    "BENCHMARK_PREFERENCE" | "SAVE_INTENT" | "CONTRIBUTION_MARGIN";
  actual: number;
  threshold: number;
  operator: ">=" | "<=" | ">";
  passed: boolean;
}

export interface GateReport {
  decision: "GO" | "NO_GO";
  sampleCount: number;
  successfulDeliveryCount: number;
  metrics: Record<string, number>;
  gates: GateResult[];
}
