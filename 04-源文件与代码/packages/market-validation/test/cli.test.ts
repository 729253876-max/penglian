import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/index.js";

const config = JSON.stringify({
  minimumSamplesByTool: {
    PORTRAIT_RETOUCH: 1,
    QUALITY_ENHANCE: 1,
    OBJECT_REMOVAL: 1,
    OLD_PHOTO_RESTORE: 1
  },
  thresholds: {
    identityPassRate: 0.95,
    severeDefectRate: 0.05,
    preferredOverOriginalRate: 0.65,
    preferredOverBenchmarkRate: 0.45,
    willingToSaveRate: 0.6
  }
});

function memoryIo(files: Record<string, string>): CliIo & { stderrText: string; written: Record<string, string> } {
  const written: Record<string, string> = {};
  let stderrText = "";
  return {
    async readText(path) {
      if (!(path in files)) throw new Error(`MISSING_FILE:${path}`);
      return files[path]!;
    },
    async writeText(path, content) { written[path] = content; },
    stdout() {},
    stderr(text) { stderrText += text; },
    get stderrText() { return stderrText; },
    written
  };
}

function inputFiles(manifest: string): Record<string, string> {
  return {
    "config.json": config,
    "manifest.csv": manifest,
    "scores.csv": [
      "sampleId,identityPass,severeDefect,preferredOverOriginal,preferredOverBenchmark,willingToSave",
      "p-1,true,false,true,true,true",
      "q-1,true,false,true,true,true",
      "o-1,true,false,true,true,true",
      "r-1,true,false,true,true,true"
    ].join("\n"),
    "costs.csv": [
      "sampleId,successfulDelivery,inferenceCostYuan,moderationCostYuan,retryCostYuan,storageCostYuan,bandwidthCostYuan,paymentFeeYuan,refundLossYuan,candidatePriceYuan",
      "p-1,true,0.3,0.03,0,0.01,0.01,0.01,0,1.99",
      "q-1,true,0.3,0.03,0,0.01,0.01,0.01,0,1.99",
      "o-1,true,0.3,0.03,0,0.01,0.01,0.01,0,1.99",
      "r-1,true,0.3,0.03,0,0.01,0.01,0.01,0,1.99"
    ].join("\n")
  };
}

const args = ["--config", "config.json", "--manifest", "manifest.csv", "--scores", "scores.csv", "--costs", "costs.csv", "--out", "report.md"];

describe("runCli", () => {
  it("returns 2 for missing arguments", async () => {
    const io = memoryIo({});
    await expect(runCli(["--config", "config.json"], io)).resolves.toBe(2);
    expect(io.stderrText).toContain("USAGE");
  });

  it("rejects fields that could leak private images or credentials", async () => {
    const io = memoryIo(inputFiles("sampleId,tool,imageUrl\np-1,PORTRAIT_RETOUCH,https://private.invalid/a.jpg"));
    expect(await runCli(args, io)).toBe(2);
    expect(io.stderrText).toContain("FORBIDDEN_FIELD:imageUrl");
  });

  it("returns 1 and writes a report for a valid NO_GO evaluation", async () => {
    const files = inputFiles([
      "sampleId,tool,identityApplicable",
      "p-1,PORTRAIT_RETOUCH,true",
      "q-1,QUALITY_ENHANCE,false",
      "o-1,OBJECT_REMOVAL,false",
      "r-1,OLD_PHOTO_RESTORE,false"
    ].join("\n"));
    files["scores.csv"] = files["scores.csv"]!.replace("p-1,true,false", "p-1,false,false");
    const io = memoryIo(files);
    expect(await runCli(args, io)).toBe(1);
    expect(io.written["report.md"]).toContain("- 判定：NO_GO");
  });

  it("returns 0 and writes a report for a valid GO evaluation", async () => {
    const io = memoryIo(inputFiles([
      "sampleId,tool,identityApplicable",
      "p-1,PORTRAIT_RETOUCH,true",
      "q-1,QUALITY_ENHANCE,false",
      "o-1,OBJECT_REMOVAL,false",
      "r-1,OLD_PHOTO_RESTORE,false"
    ].join("\n")));
    expect(await runCli(args, io)).toBe(0);
    expect(io.written["report.md"]).toContain("- 判定：GO");
  });
});
