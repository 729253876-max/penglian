import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { mergeEvaluationCsv } from "./csv.js";
import { evaluateGate, parseEvaluationConfig } from "./gate.js";
import { renderMarkdownReport } from "./report.js";

export interface CliIo {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const requiredInputFlags = ["--config", "--manifest", "--scores", "--costs"] as const;
const allFlags = [...requiredInputFlags, "--out"] as const;

function parseArgs(args: string[]): Map<string, string> | undefined {
  if (args.length % 2 !== 0) return undefined;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1]!;
    if (!allFlags.includes(flag as typeof allFlags[number]) || !value || values.has(flag)) return undefined;
    values.set(flag, value);
  }
  return requiredInputFlags.every((flag) => values.has(flag)) ? values : undefined;
}

function usage(io: CliIo): number {
  io.stderr("USAGE: --config <path> --manifest <path> --scores <path> --costs <path> --out <path>\n");
  return 2;
}

function parseConfig(text: string) {
  try {
    return parseEvaluationConfig(JSON.parse(text));
  } catch {
    throw new Error("INVALID_CONFIG");
  }
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  const paths = parseArgs(args);
  if (!paths) return usage(io);

  try {
    const inputs = await Promise.all(requiredInputFlags.map((flag) => io.readText(paths.get(flag)!)));
    const configText = inputs[0]!;
    const manifest = inputs[1]!;
    const scores = inputs[2]!;
    const costs = inputs[3]!;
    const config = parseConfig(configText);
    const report = evaluateGate(config, mergeEvaluationCsv(manifest, scores, costs));
    const output = paths.get("--out");
    if (output === undefined) return usage(io);
    await io.writeText(output, renderMarkdownReport(report));
    io.stdout(`${report.decision}\n`);
    return report.decision === "GO" ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "INVALID_INPUT"}\n`);
    return 2;
  }
}

const fileSystemIo: CliIo = {
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, content) => writeFile(path, content, "utf8"),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runCli(process.argv.slice(2), fileSystemIo).then((exitCode) => { process.exitCode = exitCode; });
}
