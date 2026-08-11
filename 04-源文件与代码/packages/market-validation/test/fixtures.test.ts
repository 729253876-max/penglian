import { readdir, readFile } from "node:fs/promises";
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

  it("keeps template headers free of image-location, direct-identity, and credential fields", async () => {
    const templateNames = (await readdir(templatesDirectory)).filter((name) => name.endsWith(".csv"));
    const headers = await Promise.all(templateNames.map(async (name) =>
      (await readFile(resolve(templatesDirectory, name), "utf8")).split(/\r?\n/, 1)[0]!
    ));

    for (const header of headers) {
      expect(header).not.toMatch(/(?:imagepath|imageurl|openid|phone|token|cookie|secret|mysqlurl|databaseurl)/i);
    }
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
