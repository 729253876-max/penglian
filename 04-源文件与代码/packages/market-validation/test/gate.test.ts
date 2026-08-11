import { describe, expect, it } from "vitest";
import { evaluateGate, type EvaluationConfig, type EvaluationSample } from "../src/index.js";

const config: EvaluationConfig = {
  minimumSamplesByTool: {
    PORTRAIT_RETOUCH: 2,
    QUALITY_ENHANCE: 1,
    OBJECT_REMOVAL: 1,
    OLD_PHOTO_RESTORE: 1
  },
  thresholds: {
    identityPassRate: 0.95,
    severeDefectRate: 0.05,
    preferredOverOriginalRate: 0.65,
    preferredOverBenchmarkRate: 0.45,
    willingToSaveRate: 0.60
  }
};

function sample(id: string, patch: Partial<EvaluationSample> = {}): EvaluationSample {
  return {
    sampleId: id,
    tool: "PORTRAIT_RETOUCH",
    identityApplicable: true,
    identityPass: true,
    severeDefect: false,
    preferredOverOriginal: true,
    preferredOverBenchmark: true,
    willingToSave: true,
    successfulDelivery: true,
    inferenceCostYuan: 0.30,
    moderationCostYuan: 0.03,
    retryCostYuan: 0,
    storageCostYuan: 0.01,
    bandwidthCostYuan: 0.01,
    paymentFeeYuan: 0.01,
    refundLossYuan: 0,
    candidatePriceYuan: 1.99,
    ...patch
  };
}

describe("evaluateGate", () => {
  it("passes only when every quality and contribution gate passes", () => {
    const report = evaluateGate(config, [
      sample("p-1"), sample("p-2"),
      sample("q-1", { tool: "QUALITY_ENHANCE", identityApplicable: false }),
      sample("o-1", { tool: "OBJECT_REMOVAL", identityApplicable: false }),
      sample("r-1", { tool: "OLD_PHOTO_RESTORE" })
    ]);
    expect(report.decision).toBe("GO");
    expect(report.gates.every((gate) => gate.passed)).toBe(true);
  });

  it("fails closed when an identity-applicable sample changes identity", () => {
    const report = evaluateGate(config, [sample("p-1", { identityPass: false })]);
    expect(report.decision).toBe("NO_GO");
    expect(report.gates).toContainEqual(expect.objectContaining({ id: "IDENTITY", passed: false }));
  });

  it("fails closed when a sample has a severe defect", () => {
    const report = evaluateGate(config, [sample("p-1", { severeDefect: true })]);
    expect(report.decision).toBe("NO_GO");
    expect(report.gates).toContainEqual(expect.objectContaining({ id: "SEVERE_DEFECT", passed: false }));
  });

  it("fails closed for an empty sample array", () => {
    const report = evaluateGate(config, []);
    expect(report.decision).toBe("NO_GO");
    expect(report.gates).toContainEqual(expect.objectContaining({ id: "COVERAGE", passed: false }));
  });

  it("rejects duplicate ids, invalid booleans, and invalid costs", () => {
    expect(() => evaluateGate(config, [sample("same"), sample("same")])).toThrow("DUPLICATE_SAMPLE_ID");
    expect(() => evaluateGate(config, [sample("boolean", { identityPass: "true" as unknown as boolean })])).toThrow("INVALID_BOOLEAN");
    expect(() => evaluateGate(config, [sample("bad", { inferenceCostYuan: Number.NaN })])).toThrow("INVALID_COST");
    expect(() => evaluateGate(config, [sample("negative", { retryCostYuan: -0.01 })])).toThrow("INVALID_COST");
  });

  it("uses the specified population for identity and preference rates", () => {
    const report = evaluateGate(config, [
      sample("p-1"),
      sample("p-2"),
      sample("q-1", {
        tool: "QUALITY_ENHANCE",
        identityApplicable: false,
        identityPass: false,
        successfulDelivery: false,
        preferredOverOriginal: false,
        preferredOverBenchmark: false,
        willingToSave: false
      }),
      sample("o-1", { tool: "OBJECT_REMOVAL", identityApplicable: false }),
      sample("r-1", { tool: "OLD_PHOTO_RESTORE", identityApplicable: false })
    ]);

    expect(report.gates).toContainEqual(expect.objectContaining({ id: "IDENTITY", actual: 1, passed: true }));
    expect(report.gates).toContainEqual(expect.objectContaining({ id: "ORIGINAL_PREFERENCE", actual: 1, passed: true }));
    expect(report.gates).toContainEqual(expect.objectContaining({ id: "BENCHMARK_PREFERENCE", actual: 1, passed: true }));
    expect(report.gates).toContainEqual(expect.objectContaining({ id: "SAVE_INTENT", actual: 1, passed: true }));
  });

  it("charges failed samples and retries against contribution margin", () => {
    const report = evaluateGate(config, [
      sample("p-1", { inferenceCostYuan: 0, moderationCostYuan: 0, storageCostYuan: 0, bandwidthCostYuan: 0, paymentFeeYuan: 0, candidatePriceYuan: 2 }),
      sample("p-2", { inferenceCostYuan: 0, moderationCostYuan: 0, storageCostYuan: 0, bandwidthCostYuan: 0, paymentFeeYuan: 0, candidatePriceYuan: 2 }),
      sample("q-1", { tool: "QUALITY_ENHANCE", identityApplicable: false, successfulDelivery: false, inferenceCostYuan: 1 }),
      sample("o-1", { tool: "OBJECT_REMOVAL", identityApplicable: false, successfulDelivery: false, retryCostYuan: 1 }),
      sample("r-1", { tool: "OLD_PHOTO_RESTORE", identityApplicable: false, successfulDelivery: false, refundLossYuan: 5 })
    ]);

    expect(report.gates).toContainEqual(expect.objectContaining({
      id: "CONTRIBUTION_MARGIN",
      threshold: 0,
      operator: ">",
      passed: false
    }));
    expect(report.gates.find((gate) => gate.id === "CONTRIBUTION_MARGIN")?.actual).toBeCloseTo(-1.89);
    expect(report.decision).toBe("NO_GO");
  });
});
