import type { GateReport, GateResult } from "./types.js";

const gateOrder: GateResult["id"][] = [
  "COVERAGE",
  "IDENTITY",
  "SEVERE_DEFECT",
  "ORIGINAL_PREFERENCE",
  "BENCHMARK_PREFERENCE",
  "SAVE_INTENT",
  "CONTRIBUTION_MARGIN"
];

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function yuan(value: number): string {
  return `¥${value.toFixed(2)}`;
}

function numerator(value: number, denominator: number): number {
  return Math.round(value * denominator);
}

function rateValue(value: number, denominator: number): string {
  return `${numerator(value, denominator)}/${denominator} (${percent(value)})`;
}

function metric(report: GateReport, name: string): number {
  const value = report.metrics[name];
  if (value === undefined) throw new Error(`MISSING_METRIC:${name}`);
  return value;
}

function formatGateActual(gate: GateResult, report: GateReport): string {
  switch (gate.id) {
    case "COVERAGE":
      return `${gate.actual}/${gate.threshold}`;
    case "IDENTITY":
      return rateValue(gate.actual, report.identityApplicableCount);
    case "SEVERE_DEFECT":
      return rateValue(gate.actual, report.sampleCount);
    case "ORIGINAL_PREFERENCE":
    case "BENCHMARK_PREFERENCE":
    case "SAVE_INTENT":
      return rateValue(gate.actual, report.successfulDeliveryCount);
    case "CONTRIBUTION_MARGIN":
      return yuan(gate.actual);
  }
}

function formatGateThreshold(gate: GateResult): string {
  return gate.id === "COVERAGE"
    ? `${gate.operator} ${gate.threshold}`
    : gate.id === "CONTRIBUTION_MARGIN"
      ? `${gate.operator} ${yuan(gate.threshold)}`
      : `${gate.operator} ${percent(gate.threshold)}`;
}

export function renderMarkdownReport(report: GateReport): string {
  const gates = [...report.gates].sort((left, right) =>
    gateOrder.indexOf(left.id) - gateOrder.indexOf(right.id)
  );
  const gateRows = gates.map((gate) =>
    `| ${gate.id} | ${formatGateActual(gate, report)} | ${formatGateThreshold(gate)} | ${gate.passed ? "PASS" : "FAIL"} |`
  );
  const metricRows = [
    ["覆盖工具数", `${metric(report, "coverageSatisfiedToolCount")}/4`],
    ["身份保持通过率", rateValue(metric(report, "identityPassRate"), report.identityApplicableCount)],
    ["严重缺陷率", rateValue(metric(report, "severeDefectRate"), report.sampleCount)],
    ["原图偏好率", rateValue(metric(report, "preferredOverOriginalRate"), report.successfulDeliveryCount)],
    ["基准偏好率", rateValue(metric(report, "preferredOverBenchmarkRate"), report.successfulDeliveryCount)],
    ["保存意愿率", rateValue(metric(report, "willingToSaveRate"), report.successfulDeliveryCount)],
    ["单次成功交付贡献", yuan(metric(report, "contributionPerDelivery"))]
  ].map(([metric, actual]) => `| ${metric} | ${actual} |`);

  return [
    "# V1 真实质量与成本门禁报告",
    "",
    `- 判定：${report.decision}`,
    `- 样本数：${report.sampleCount}`,
    `- 成功交付数：${report.successfulDeliveryCount}`,
    "",
    "| 指标 | 实际值 |",
    "|---|---:|",
    ...metricRows,
    "",
    "| 门禁 | 实际值 | 阈值 | 结果 |",
    "|---|---:|---:|---|",
    ...gateRows,
    "",
    "> B1-ENV 仍为 NOT RUN；本任务不构成真实市场验证，也不等于产品可发布。"
  ].join("\n");
}
