import type { EvaluationSample, EvaluationTool } from "./types.js";
import { isAnonymousSlug } from "./validation.js";

const forbiddenFields = new Set([
  "imagepath", "imageurl", "openid", "phone", "token", "cookie", "secret", "mysqlurl", "databaseurl"
]);

const manifestHeaders = [
  "sampleId", "tool", "scenario", "identityApplicable", "authorizedForEvaluation"
] as const;
const scoresHeaders = [
  "sampleId", "reviewerId", "identityPass", "severeDefect", "preferredOverOriginal",
  "preferredOverBenchmark", "willingToSave"
] as const;
const costsHeaders = [
  "sampleId", "successfulDelivery", "inferenceCostYuan", "moderationCostYuan", "retryCostYuan",
  "storageCostYuan", "bandwidthCostYuan", "paymentFeeYuan", "refundLossYuan", "candidatePriceYuan"
] as const;
const tools = new Set<EvaluationTool>([
  "PORTRAIT_RETOUCH", "QUALITY_ENHANCE", "OBJECT_REMOVAL", "OLD_PHOTO_RESTORE"
]);

type CsvRow = Record<string, string>;

function requiredValue(row: CsvRow, field: string): string {
  const value = row[field];
  if (value === undefined) throw new Error("INVALID_CSV_ROW");
  return value;
}

export function assertNoForbiddenFields(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if ([...forbiddenFields].some((field) => normalizedKey.includes(field))) throw new Error(`FORBIDDEN_FIELD:${key}`);
    assertNoForbiddenFields(child);
  }
}

function parseCsv(text: string, headers: readonly string[]): CsvRow[] {
  const lines = text.replace(/^\uFEFF/, "").split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1 || lines.some((line) => line.includes('"'))) throw new Error("INVALID_CSV");
  const actualHeaders = lines[0]!.split(",");
  assertNoForbiddenFields(Object.fromEntries(actualHeaders.map((header) => [header, true])));
  if (actualHeaders.length !== headers.length || actualHeaders.some((header, index) => header !== headers[index])) {
    throw new Error("INVALID_CSV_HEADER");
  }

  return lines.slice(1).map((line) => {
    const values = line.split(",");
    if (values.length !== headers.length || values.some((value) => value.length === 0)) throw new Error("INVALID_CSV_ROW");
    return Object.fromEntries(headers.map((header, index) => [header, values[index]!])) as CsvRow;
  });
}

function assertSlug(value: string, field: string): void {
  if (!isAnonymousSlug(value)) throw new Error(`INVALID_CSV_VALUE:${field}`);
}

function booleanValue(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`INVALID_CSV_VALUE:${field}`);
}

function numberValue(value: string, field: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`INVALID_CSV_VALUE:${field}`);
  return Number(value);
}

function rowsBySampleId(rows: CsvRow[]): Map<string, CsvRow> {
  const result = new Map<string, CsvRow>();
  for (const row of rows) {
    const sampleId = requiredValue(row, "sampleId");
    assertSlug(sampleId, "sampleId");
    if (result.has(sampleId)) throw new Error("DUPLICATE_SAMPLE_ID");
    result.set(sampleId, row);
  }
  return result;
}

function assertMatchingIds(manifest: Map<string, CsvRow>, other: Map<string, CsvRow>): void {
  if (manifest.size !== other.size || [...manifest.keys()].some((sampleId) => !other.has(sampleId))) {
    throw new Error("MISMATCHED_SAMPLE_IDS");
  }
}

export function mergeEvaluationCsv(manifestCsv: string, scoresCsv: string, costsCsv: string): EvaluationSample[] {
  const manifest = parseCsv(manifestCsv, manifestHeaders);
  const scores = rowsBySampleId(parseCsv(scoresCsv, scoresHeaders));
  const costs = rowsBySampleId(parseCsv(costsCsv, costsHeaders));
  const manifests = rowsBySampleId(manifest);
  assertMatchingIds(manifests, scores);
  assertMatchingIds(manifests, costs);

  return manifest.map((row) => {
    const sampleId = requiredValue(row, "sampleId");
    const score = scores.get(sampleId)!;
    const cost = costs.get(sampleId)!;
    const tool = requiredValue(row, "tool");
    if (!tools.has(tool as EvaluationTool)) throw new Error("INVALID_CSV_VALUE:tool");
    assertSlug(requiredValue(row, "scenario"), "scenario");
    assertSlug(requiredValue(score, "reviewerId"), "reviewerId");
    const authorizedForEvaluation = booleanValue(
      requiredValue(row, "authorizedForEvaluation"),
      "authorizedForEvaluation"
    );
    if (!authorizedForEvaluation) throw new Error(`UNAUTHORIZED_SAMPLE:${sampleId}`);
    return {
      sampleId,
      tool: tool as EvaluationTool,
      authorizedForEvaluation,
      identityApplicable: booleanValue(requiredValue(row, "identityApplicable"), "identityApplicable"),
      identityPass: booleanValue(requiredValue(score, "identityPass"), "identityPass"),
      severeDefect: booleanValue(requiredValue(score, "severeDefect"), "severeDefect"),
      preferredOverOriginal: booleanValue(requiredValue(score, "preferredOverOriginal"), "preferredOverOriginal"),
      preferredOverBenchmark: booleanValue(requiredValue(score, "preferredOverBenchmark"), "preferredOverBenchmark"),
      willingToSave: booleanValue(requiredValue(score, "willingToSave"), "willingToSave"),
      successfulDelivery: booleanValue(requiredValue(cost, "successfulDelivery"), "successfulDelivery"),
      inferenceCostYuan: numberValue(requiredValue(cost, "inferenceCostYuan"), "inferenceCostYuan"),
      moderationCostYuan: numberValue(requiredValue(cost, "moderationCostYuan"), "moderationCostYuan"),
      retryCostYuan: numberValue(requiredValue(cost, "retryCostYuan"), "retryCostYuan"),
      storageCostYuan: numberValue(requiredValue(cost, "storageCostYuan"), "storageCostYuan"),
      bandwidthCostYuan: numberValue(requiredValue(cost, "bandwidthCostYuan"), "bandwidthCostYuan"),
      paymentFeeYuan: numberValue(requiredValue(cost, "paymentFeeYuan"), "paymentFeeYuan"),
      refundLossYuan: numberValue(requiredValue(cost, "refundLossYuan"), "refundLossYuan"),
      candidatePriceYuan: numberValue(requiredValue(cost, "candidatePriceYuan"), "candidatePriceYuan")
    };
  });
}
