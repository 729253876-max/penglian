import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = resolve(testDirectory, "fixtures");
const templatesDirectory = resolve(testDirectory, "../../../../03-素材与资源/市场验证");

function file(name: string): string {
  return resolve(fixturesDirectory, name);
}

function diskIo(): CliIo & { report: string; stderrText: string } {
  let report = "";
  let stderrText = "";
  return {
    readText: (path) => readFile(path, "utf8"),
    writeText: async (_path, content) => { report = content; },
    stdout: () => {},
    stderr: (text) => { stderrText += text; },
    get report() { return report; },
    get stderrText() { return stderrText; }
  };
}

describe("anonymous quality gate fixtures", () => {
  it("returns GO for the deterministic passing fixture", async () => {
    const io = diskIo();
    const exitCode = await runCli([
      "--config", file("go-config.json"),
      "--manifest", file("go-manifest.csv"),
      "--scores", file("go-scores.csv"),
      "--costs", file("go-costs.csv"),
      "--out", "report.md"
    ], io);
    expect(io.stderrText).toBe("");
    expect(exitCode).toBe(0);
  });

  it("returns NO_GO when identity and contribution margin fail", async () => {
    const io = diskIo();
    const exitCode = await runCli([
      "--config", file("go-config.json"),
      "--manifest", file("go-manifest.csv"),
      "--scores", file("no-go-scores.csv"),
      "--costs", file("no-go-costs.csv"),
      "--out", "report.md"
    ], io);
    expect(io.stderrText).toBe("");
    expect(exitCode).toBe(1);
    expect(io.report).toMatch(/\| IDENTITY \|.*\| FAIL \|/);
    expect(io.report).toMatch(/\| CONTRIBUTION_MARGIN \|.*\| FAIL \|/);
  });

  it("executes the raw approved templates without trimming their file contents", async () => {
    const io = diskIo();
    const exitCode = await runCli([
      "--config", resolve(templatesDirectory, "gate-config-v01.json"),
      "--manifest", resolve(templatesDirectory, "anonymous-sample-manifest-template-v01.csv"),
      "--scores", resolve(templatesDirectory, "blind-score-template-v01.csv"),
      "--costs", resolve(templatesDirectory, "cost-template-v01.csv"),
      "--out", "report.md"
    ], io);

    expect(io.stderrText).toBe("");
    expect(exitCode).toBe(1);
    expect(io.report).toContain("- 判定：NO_GO");
  });

  it("allows only anonymous manifest, blind-score, and cost template fields with bounded example values", async () => {
    const readTemplate = async (name: string) => {
      const lines = (await readFile(resolve(templatesDirectory, name), "utf8")).trim().split(/\r?\n/);
      return { headers: lines[0]!.split(","), values: lines[1]!.split(",") };
    };
    const isBoolean = (value: string) => value === "true" || value === "false";
    const isNonNegativeFinite = (value: string) => Number.isFinite(Number(value)) && Number(value) >= 0;

    const manifest = await readTemplate("anonymous-sample-manifest-template-v01.csv");
    expect(manifest.headers).toEqual([
      "sampleId", "tool", "scenario", "identityApplicable", "authorizedForEvaluation"
    ]);
    expect(manifest.values[0]).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(manifest.values[1]).toMatch(/^(?:PORTRAIT_RETOUCH|QUALITY_ENHANCE|OBJECT_REMOVAL|OLD_PHOTO_RESTORE)$/);
    expect(manifest.values[2]).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(manifest.values.slice(3).every(isBoolean)).toBe(true);

    const scores = await readTemplate("blind-score-template-v01.csv");
    expect(scores.headers).toEqual([
      "sampleId", "reviewerId", "identityPass", "severeDefect", "preferredOverOriginal",
      "preferredOverBenchmark", "willingToSave"
    ]);
    expect(scores.values.slice(0, 2).every((value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))).toBe(true);
    expect(scores.values.slice(2).every(isBoolean)).toBe(true);

    const costs = await readTemplate("cost-template-v01.csv");
    expect(costs.headers).toEqual([
      "sampleId", "successfulDelivery", "inferenceCostYuan", "moderationCostYuan", "retryCostYuan",
      "storageCostYuan", "bandwidthCostYuan", "paymentFeeYuan", "refundLossYuan", "candidatePriceYuan"
    ]);
    expect(costs.values[0]).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(isBoolean(costs.values[1]!)).toBe(true);
    expect(costs.values.slice(2).every(isNonNegativeFinite)).toBe(true);
  });

  it("states that fixtures are not market, quality, or release evidence and B1-ENV is not run", async () => {
    const readme = await readFile(resolve(templatesDirectory, "README.md"), "utf8");

    expect(readme).toContain("这些 fixture 仅用于可复现的 CLI 测试");
    expect(readme).toContain("不是实际市场、质量或产品发布证据");
    expect(readme).toContain("`B1-ENV` 当前未运行");
  });

  it("keeps the current 40/20/20/20 sampling plan and five stop lines", async () => {
    const config = JSON.parse(await readFile(resolve(templatesDirectory, "gate-config-v01.json"), "utf8"));

    expect(config.minimumSamplesByTool).toEqual({
      PORTRAIT_RETOUCH: 40,
      QUALITY_ENHANCE: 20,
      OBJECT_REMOVAL: 20,
      OLD_PHOTO_RESTORE: 20
    });
    expect(config.thresholds).toEqual({
      identityPassRate: 0.95,
      severeDefectRate: 0.05,
      preferredOverOriginalRate: 0.65,
      preferredOverBenchmarkRate: 0.45,
      willingToSaveRate: 0.6
    });
  });
});
