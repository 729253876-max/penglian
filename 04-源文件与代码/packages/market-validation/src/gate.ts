import type {
  EvaluationConfig,
  EvaluationSample,
  EvaluationTool,
  GateReport,
  GateResult
} from "./types.js";

const tools: EvaluationTool[] = [
  "PORTRAIT_RETOUCH",
  "QUALITY_ENHANCE",
  "OBJECT_REMOVAL",
  "OLD_PHOTO_RESTORE"
];

const booleanFields = [
  "identityApplicable",
  "identityPass",
  "severeDefect",
  "preferredOverOriginal",
  "preferredOverBenchmark",
  "willingToSave",
  "successfulDelivery"
] as const;

const costFields = [
  "inferenceCostYuan",
  "moderationCostYuan",
  "retryCostYuan",
  "storageCostYuan",
  "bandwidthCostYuan",
  "paymentFeeYuan",
  "refundLossYuan"
] as const;

const sampleFields = [
  "sampleId",
  "tool",
  ...booleanFields,
  ...costFields,
  "candidatePriceYuan"
] as const;

function validateSamples(samples: EvaluationSample[]): void {
  const sampleIds = new Set<string>();

  for (const sample of samples) {
    for (const field of Object.keys(sample)) {
      if (!sampleFields.includes(field as typeof sampleFields[number])) {
        throw new Error("UNKNOWN_SAMPLE_FIELD");
      }
    }

    if (typeof sample.sampleId !== "string" || sample.sampleId.trim().length === 0) {
      throw new Error("INVALID_SAMPLE_ID");
    }

    if (!tools.includes(sample.tool)) {
      throw new Error("INVALID_TOOL");
    }

    if (sampleIds.has(sample.sampleId)) {
      throw new Error("DUPLICATE_SAMPLE_ID");
    }
    sampleIds.add(sample.sampleId);

    for (const field of booleanFields) {
      if (typeof sample[field] !== "boolean") {
        throw new Error("INVALID_BOOLEAN");
      }
    }

    for (const field of costFields) {
      if (!Number.isFinite(sample[field]) || sample[field] < 0) {
        throw new Error("INVALID_COST");
      }
    }

    if (!Number.isFinite(sample.candidatePriceYuan) || sample.candidatePriceYuan < 0) {
      throw new Error("INVALID_PRICE");
    }
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateGate(config: EvaluationConfig, samples: EvaluationSample[]): GateReport {
  validateSamples(samples);

  const delivered = samples.filter((sample) => sample.successfulDelivery);
  const identity = samples.filter((sample) => sample.identityApplicable);
  const coveredTools = tools.filter((tool) =>
    samples.filter((sample) => sample.tool === tool).length >= config.minimumSamplesByTool[tool]
  ).length;
  const identityPassRate = rate(identity.filter((sample) => sample.identityPass).length, identity.length);
  const severeDefectRate = rate(samples.filter((sample) => sample.severeDefect).length, samples.length);
  const preferredOverOriginalRate = rate(
    delivered.filter((sample) => sample.preferredOverOriginal).length,
    delivered.length
  );
  const preferredOverBenchmarkRate = rate(
    delivered.filter((sample) => sample.preferredOverBenchmark).length,
    delivered.length
  );
  const willingToSaveRate = rate(delivered.filter((sample) => sample.willingToSave).length, delivered.length);
  const totalCost = samples.reduce((sum, sample) => sum +
    sample.inferenceCostYuan + sample.moderationCostYuan + sample.retryCostYuan +
    sample.storageCostYuan + sample.bandwidthCostYuan + sample.paymentFeeYuan +
    sample.refundLossYuan, 0);
  const totalRevenue = delivered.reduce((sum, sample) => sum + sample.candidatePriceYuan, 0);
  const contributionPerDelivery = delivered.length === 0
    ? Number.NEGATIVE_INFINITY
    : (totalRevenue - totalCost) / delivered.length;
  const gates: GateResult[] = [
    { id: "COVERAGE", actual: coveredTools, threshold: tools.length, operator: ">=", passed: coveredTools === tools.length },
    { id: "IDENTITY", actual: identityPassRate, threshold: config.thresholds.identityPassRate, operator: ">=", passed: identityPassRate >= config.thresholds.identityPassRate },
    { id: "SEVERE_DEFECT", actual: severeDefectRate, threshold: config.thresholds.severeDefectRate, operator: "<=", passed: severeDefectRate <= config.thresholds.severeDefectRate },
    { id: "ORIGINAL_PREFERENCE", actual: preferredOverOriginalRate, threshold: config.thresholds.preferredOverOriginalRate, operator: ">=", passed: preferredOverOriginalRate >= config.thresholds.preferredOverOriginalRate },
    { id: "BENCHMARK_PREFERENCE", actual: preferredOverBenchmarkRate, threshold: config.thresholds.preferredOverBenchmarkRate, operator: ">=", passed: preferredOverBenchmarkRate >= config.thresholds.preferredOverBenchmarkRate },
    { id: "SAVE_INTENT", actual: willingToSaveRate, threshold: config.thresholds.willingToSaveRate, operator: ">=", passed: willingToSaveRate >= config.thresholds.willingToSaveRate },
    { id: "CONTRIBUTION_MARGIN", actual: contributionPerDelivery, threshold: 0, operator: ">", passed: contributionPerDelivery > 0 }
  ];
  const metrics = {
    coverageSatisfiedToolCount: coveredTools,
    identityPassRate,
    severeDefectRate,
    preferredOverOriginalRate,
    preferredOverBenchmarkRate,
    willingToSaveRate,
    contributionPerDelivery
  };
  const decision = gates.every((gate) => gate.passed) ? "GO" : "NO_GO";

  return {
    decision,
    sampleCount: samples.length,
    successfulDeliveryCount: delivered.length,
    identityApplicableCount: identity.length,
    metrics,
    gates
  };
}
