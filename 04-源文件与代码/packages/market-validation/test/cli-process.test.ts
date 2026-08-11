import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const fixtureDirectory = resolve(testDirectory, "fixtures");
const createdFiles = ["config.json", "manifest.csv", "scores.csv", "go-costs.csv", "no-go-costs.csv", "go-report.md", "no-go-report.md"];
let temporaryDirectory = "";

async function copyFixture(source: string, target: string): Promise<void> {
  await writeFile(resolve(temporaryDirectory, target), await readFile(resolve(fixtureDirectory, source), "utf8"), "utf8");
}

function runEvaluation(costs: string, output: string, extraArgs: string[] = []) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = [
    "run", "evaluate", "-w", "@photo-ai/market-validation", "--",
    "--config", resolve(temporaryDirectory, "config.json"),
    "--manifest", resolve(temporaryDirectory, "manifest.csv"),
    "--scores", resolve(temporaryDirectory, "scores.csv"),
    "--costs", resolve(temporaryDirectory, costs),
    "--out", resolve(temporaryDirectory, output),
    ...extraArgs
  ];
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npmCommand;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", npmCommand, ...npmArgs] : npmArgs;
  return spawnSync(command, commandArgs, {
    cwd: workspaceDirectory,
    encoding: "utf8",
    timeout: 30_000
  });
}

describe("market-validation CLI process exit codes", () => {
  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "market-validation-cli-"));
    await Promise.all([
      copyFixture("go-config.json", "config.json"),
      copyFixture("go-manifest.csv", "manifest.csv"),
      copyFixture("go-scores.csv", "scores.csv"),
      copyFixture("go-costs.csv", "go-costs.csv"),
      copyFixture("no-go-costs.csv", "no-go-costs.csv")
    ]);
  });

  afterAll(async () => {
    for (const name of createdFiles) {
      await rm(resolve(temporaryDirectory, name), { force: true });
    }
    await rmdir(temporaryDirectory);
  });

  it("returns OS exit code 0 for GO through the documented npm invocation", () => {
    const result = runEvaluation("go-costs.csv", "go-report.md");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GO");
  });

  it("returns OS exit code 1 for NO_GO through npm argument forwarding", () => {
    const result = runEvaluation("no-go-costs.csv", "no-go-report.md");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("NO_GO");
  });

  it("returns OS exit code 2 for invalid input through the real Node entry", () => {
    const result = runEvaluation("missing-costs.csv", "invalid-report.md");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ENOENT");
  });
});
