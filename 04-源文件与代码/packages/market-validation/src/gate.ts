import type {
  EvaluationConfig,
  EvaluationSample,
  EvaluationTool,
  GateReport,
  GateResult
} from "./types.js";
import { isAnonymousSlug } from "./validation.js";

const tools: EvaluationTool[] = [
  "PORTRAIT_RETOUCH",
  "QUALITY_ENHANCE",
  "OBJECT_REMOVAL",
  "OLD_PHOTO_RESTORE"
];

const thresholdFloors = {
  identityPassRate: 0.95,
  severeDefectRate: 0.05,
  preferredOverOriginalRate: 0.65,
  preferredOverBenchmarkRate: 0.45,
  willingToSaveRate: 0.60
} as const;

function invalidConfig(): never {
  throw new Error("INVALID_CONFIG");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !(key in value))) invalidConfig();
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidConfig();
  return value;
}

function validatedRate(value: unknown, floor: number, direction: ">=" | "<="): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalidConfig();
  if ((direction === ">=" && value < floor) || (direction === "<=" && value > floor)) invalidConfig();
  return value;
}

export function parseEvaluationConfig(value: unknown): EvaluationConfig {
  if (!isRecord(value)) invalidConfig();
  requireExactKeys(value, ["minimumSamplesByTool", "thresholds"]);
  const minimumSamplesByTool = value.minimumSamplesByTool;
  const thresholds = value.thresholds;
  if (!isRecord(minimumSamplesByTool) || !isRecord(thresholds)) invalidConfig();
  requireExactKeys(minimumSamplesByTool, tools);
  requireExactKeys(thresholds, Object.keys(thresholdFloors));

  return {
    minimumSamplesByTool: {
      PORTRAIT_RETOUCH: positiveInteger(minimumSamplesByTool.PORTRAIT_RETOUCH),
      QUALITY_ENHANCE: positiveInteger(minimumSamplesByTool.QUALITY_ENHANCE),
      OBJECT_REMOVAL: positiveInteger(minimumSamplesByTool.OBJECT_REMOVAL),
      OLD_PHOTO_RESTORE: positiveInteger(minimumSamplesByTool.OLD_PHOTO_RESTORE)
    },
    thresholds: {
      identityPassRate: validatedRate(thresholds.identityPassRate, thresholdFloors.identityPassRate, ">="),
      severeDefectRate: validatedRate(thresholds.severeDefectRate, thresholdFloors.severeDefectRate, "<="),
      preferredOverOriginalRate: validatedRate(thresholds.preferredOverOriginalRate, thresholdFloors.preferredOverOriginalRate, ">="),
      preferredOverBenchmarkRate: validatedRate(thresholds.preferredOverBenchmarkRate, thresholdFloors.preferredOverBenchmarkRate, ">="),
      willingToSaveRate: validatedRate(thresholds.willingToSaveRate, thresholdFloors.willingToSaveRate, ">=")
    }
  };
}

const booleanFields = [
  "authorizedForEvaluation",
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

    if (!isAnonymousSlug(sample.sampleId)) {
      throw new Error("INVALID_SAMPLE_ID");
    }

    if (sample.authorizedForEvaluation !== true) {
      throw new Error("UNAUTHORIZED_SAMPLE");
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

    for (const field of costFields) moneyToFen(sample[field], "INVALID_COST");
    moneyToFen(sample.candidatePriceYuan, "INVALID_PRICE");
  }
}

function moneyToFen(value: number, errorCode: "INVALID_COST" | "INVALID_PRICE"): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(errorCode);
  const fen = Math.round(value * 100);
  if (!Number.isSafeInteger(fen) || Math.abs(value * 100 - fen) > 1e-8) throw new Error(errorCode);
  return fen;
}

function addFen(total: number, value: number, errorCode: "INVALID_COST" | "INVALID_PRICE"): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) throw new Error(errorCode);
  return result;
}

function fenToYuan(fen: number): number {
  return fen / 100;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateGate(config: EvaluationConfig, samples: EvaluationSample[]): GateReport {
  config = parseEvaluationConfig(config);
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
  const costSubtotalFen = Object.fromEntries(costFields.map((field) => [
    field,
    samples.reduce((sum, sample) => addFen(sum, moneyToFen(sample[field], "INVALID_COST"), "INVALID_COST"), 0)
  ])) as Record<typeof costFields[number], number>;
  const totalCostFen = costFields.reduce((sum, field) =>
    addFen(sum, costSubtotalFen[field], "INVALID_COST"), 0);
  const totalRevenueFen = delivered.reduce((sum, sample) =>
    addFen(sum, moneyToFen(sample.candidatePriceYuan, "INVALID_PRICE"), "INVALID_PRICE"), 0);
  const contributionFen = totalRevenueFen - totalCostFen;
  const contributionPerDelivery = delivered.length === 0
    ? Number.NEGATIVE_INFINITY
    : contributionFen === 0 ? 0 : fenToYuan(contributionFen) / delivered.length;
  const gates: GateResult[] = [
    { id: "COVERAGE", actual: coveredTools, threshold: tools.length, operator: ">=", passed: coveredTools === tools.length },
    { id: "IDENTITY", actual: identityPassRate, threshold: config.thresholds.identityPassRate, operator: ">=", passed: identityPassRate >= config.thresholds.identityPassRate },
    { id: "SEVERE_DEFECT", actual: severeDefectRate, threshold: config.thresholds.severeDefectRate, operator: "<=", passed: severeDefectRate <= config.thresholds.severeDefectRate },
    { id: "ORIGINAL_PREFERENCE", actual: preferredOverOriginalRate, threshold: config.thresholds.preferredOverOriginalRate, operator: ">=", passed: preferredOverOriginalRate >= config.thresholds.preferredOverOriginalRate },
    { id: "BENCHMARK_PREFERENCE", actual: preferredOverBenchmarkRate, threshold: config.thresholds.preferredOverBenchmarkRate, operator: ">=", passed: preferredOverBenchmarkRate >= config.thresholds.preferredOverBenchmarkRate },
    { id: "SAVE_INTENT", actual: willingToSaveRate, threshold: config.thresholds.willingToSaveRate, operator: ">=", passed: willingToSaveRate >= config.thresholds.willingToSaveRate },
    { id: "CONTRIBUTION_MARGIN", actual: fenToYuan(contributionFen), threshold: 0, operator: ">", passed: contributionFen > 0 }
  ];
  const metrics = {
    coverageSatisfiedToolCount: coveredTools,
    identityPassRate,
    severeDefectRate,
    preferredOverOriginalRate,
    preferredOverBenchmarkRate,
    willingToSaveRate,
    contributionPerDelivery,
    totalCostYuan: fenToYuan(totalCostFen),
    totalRevenueYuan: fenToYuan(totalRevenueFen),
    inferenceCostSubtotalYuan: fenToYuan(costSubtotalFen.inferenceCostYuan),
    moderationCostSubtotalYuan: fenToYuan(costSubtotalFen.moderationCostYuan),
    retryCostSubtotalYuan: fenToYuan(costSubtotalFen.retryCostYuan),
    storageCostSubtotalYuan: fenToYuan(costSubtotalFen.storageCostYuan),
    bandwidthCostSubtotalYuan: fenToYuan(costSubtotalFen.bandwidthCostYuan),
    paymentFeeSubtotalYuan: fenToYuan(costSubtotalFen.paymentFeeYuan),
    refundLossSubtotalYuan: fenToYuan(costSubtotalFen.refundLossYuan)
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
