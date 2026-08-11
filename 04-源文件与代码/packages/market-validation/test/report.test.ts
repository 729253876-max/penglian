import { describe, expect, it } from "vitest";
import { renderMarkdownReport, type GateReport } from "../src/index.js";

const report: GateReport = {
  decision: "NO_GO",
  sampleCount: 10,
  successfulDeliveryCount: 8,
  identityApplicableCount: 6,
  metrics: {
    coverageSatisfiedToolCount: 3,
    identityPassRate: 5 / 6,
    severeDefectRate: 1 / 10,
    preferredOverOriginalRate: 6 / 8,
    preferredOverBenchmarkRate: 4 / 8,
    willingToSaveRate: 5 / 8,
    contributionPerDelivery: 1.234
  },
  gates: [
    { id: "COVERAGE", actual: 3, threshold: 4, operator: ">=", passed: false },
    { id: "IDENTITY", actual: 5 / 6, threshold: 0.95, operator: ">=", passed: false },
    { id: "SEVERE_DEFECT", actual: 1 / 10, threshold: 0.05, operator: "<=", passed: false },
    { id: "ORIGINAL_PREFERENCE", actual: 6 / 8, threshold: 0.65, operator: ">=", passed: true },
    { id: "BENCHMARK_PREFERENCE", actual: 4 / 8, threshold: 0.45, operator: ">=", passed: true },
    { id: "SAVE_INTENT", actual: 5 / 8, threshold: 0.6, operator: ">=", passed: true },
    { id: "CONTRIBUTION_MARGIN", actual: 1.234, threshold: 0, operator: ">", passed: true }
  ]
};

describe("renderMarkdownReport", () => {
  it("renders every gate with stable order, exact denominators, and display precision", () => {
    const markdown = renderMarkdownReport(report);

    expect(markdown).toContain("# V1 真实质量与成本门禁报告");
    expect(markdown).toContain("- 判定：NO_GO");
    expect(markdown).toContain("| IDENTITY | 5/6 (83.3%) | >= 95.0% | FAIL |");
    expect(markdown).toContain("| SEVERE_DEFECT | 1/10 (10.0%) | <= 5.0% | FAIL |");
    expect(markdown).toContain("| CONTRIBUTION_MARGIN | ¥1.23 | > ¥0.00 | PASS |");
    expect(markdown.match(/^\| (?:COVERAGE|IDENTITY|SEVERE_DEFECT|ORIGINAL_PREFERENCE|BENCHMARK_PREFERENCE|SAVE_INTENT|CONTRIBUTION_MARGIN) \|/gm))
      .toHaveLength(7);
    expect(markdown).not.toContain('"metrics"');
    expect(markdown).toContain("> B1-ENV 仍为 NOT RUN；本任务不构成真实市场验证，也不等于产品可发布。");
  });
});
