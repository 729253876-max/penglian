import { describe, expect, it } from "vitest";
import { mergeEvaluationCsv } from "../src/index.js";

const manifest = [
  "sampleId,tool,identityApplicable",
  "p-1,PORTRAIT_RETOUCH,true",
  "q-1,QUALITY_ENHANCE,false"
].join("\n");
const scores = [
  "sampleId,identityPass,severeDefect,preferredOverOriginal,preferredOverBenchmark,willingToSave",
  "p-1,true,false,true,true,true",
  "q-1,false,false,true,true,true"
].join("\n");
const costs = [
  "sampleId,successfulDelivery,inferenceCostYuan,moderationCostYuan,retryCostYuan,storageCostYuan,bandwidthCostYuan,paymentFeeYuan,refundLossYuan,candidatePriceYuan",
  "p-1,true,0.30,0.03,0,0.01,0.01,0.01,0,1.99",
  "q-1,true,0.30,0.03,0,0.01,0.01,0.01,0,1.99"
].join("\n");

describe("mergeEvaluationCsv", () => {
  it("merges the three fixed CSV schemas by sampleId without changing the manifest order", () => {
    expect(mergeEvaluationCsv(manifest, scores, costs)).toEqual([
      expect.objectContaining({ sampleId: "p-1", tool: "PORTRAIT_RETOUCH", identityApplicable: true }),
      expect.objectContaining({ sampleId: "q-1", tool: "QUALITY_ENHANCE", identityApplicable: false })
    ]);
  });

  it("rejects duplicate, missing, and orphan sample IDs instead of dropping rows", () => {
    expect(() => mergeEvaluationCsv(manifest.replace("q-1,QUALITY_ENHANCE,false", "p-1,QUALITY_ENHANCE,false"), scores, costs))
      .toThrow("DUPLICATE_SAMPLE_ID");
    expect(() => mergeEvaluationCsv(manifest, scores.replace("q-1,false,false,true,true,true", "x-1,false,false,true,true,true"), costs))
      .toThrow("MISMATCHED_SAMPLE_IDS");
  });

  it("rejects free text CSV fields and sensitive headers", () => {
    expect(() => mergeEvaluationCsv(manifest.replace("p-1,PORTRAIT_RETOUCH,true", "p-1,PORTRAIT RETOUCH,true"), scores, costs))
      .toThrow("INVALID_CSV_VALUE:tool");
    expect(() => mergeEvaluationCsv(
      "sampleId,tool,imageUrl\np-1,PORTRAIT_RETOUCH,https://private.invalid/a.jpg",
      scores,
      costs
    )).toThrow("FORBIDDEN_FIELD:imageUrl");
  });
});
