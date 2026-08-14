import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWorkflowContract } from "../src/workflow-contract.js";

const valid = `name: PR Quality Gate

on:
  pull_request:
    branches:
      - master
  workflow_dispatch:

permissions:
  contents: read

jobs:
  quality-gate:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@7c2c68d20d402ed6a201ada70a81341941093140
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: 04-源文件与代码/package-lock.json
      - run: npm.cmd ci --ignore-scripts
        working-directory: 04-源文件与代码
      - run: npm.cmd run typecheck
        working-directory: 04-源文件与代码
      - run: npm.cmd test -- --run
        working-directory: 04-源文件与代码
      - run: npm.cmd run verify:miniprogram-runtime
        working-directory: 04-源文件与代码
      - run: npm.cmd run build:wechat -w @photo-ai/miniprogram
        working-directory: 04-源文件与代码
      - run: git diff --check origin/master...HEAD
        working-directory: .
`;

const mutationCases: ReadonlyArray<readonly [string, string]> = [
  ["FORBIDDEN_TRIGGER", valid.replace("pull_request:", "pull_request_target:")],
  ["MISSING_TRIGGER", valid.replace("  workflow_dispatch:\n", "")],
  ["EXCESS_PERMISSION", valid.replace("contents: read", "contents: write")],
  ["FLOATING_ACTION", valid.replace(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/checkout@v7"
  )],
  ["UNAPPROVED_ACTION", valid.replace(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "untrusted/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  )],
  ["WRONG_RUNNER", valid.replace("windows-latest", "ubuntu-latest")],
  ["WRONG_NODE", valid.replace("node-version: 24", "node-version: 22")],
  ["WRONG_CACHE_PATH", valid.replace(
    "04-源文件与代码/package-lock.json",
    "package-lock.json"
  )],
  ["WRONG_CHECKOUT", valid.replace("fetch-depth: 0", "fetch-depth: 1")],
  ["WRONG_WORKDIR", valid.replace(
    "run: npm.cmd ci --ignore-scripts\n        working-directory: 04-源文件与代码",
    "run: npm.cmd ci --ignore-scripts\n        working-directory: ."
  )],
  ["FORBIDDEN_INSTALL_SCRIPT", valid.replace(
    "npm.cmd ci --ignore-scripts",
    "npm.cmd ci"
  )],
  ["MISSING_GATE", valid.replace("run: npm.cmd run typecheck", "run: npm.cmd run omitted")],
  ["GATE_ORDER", valid
    .replace("run: npm.cmd run typecheck", "run: __TYPECHECK__")
    .replace("run: npm.cmd test -- --run", "run: npm.cmd run typecheck")
    .replace("run: __TYPECHECK__", "run: npm.cmd test -- --run")],
  ["FILTERED_TESTS", valid.replace(
    "npm.cmd test -- --run",
    "npm.cmd test -- --run apps/api/test/task-service.test.ts"
  )],
  ["FORBIDDEN_SECRET", `${valid}\nenv:\n  TOKEN: \${{ secrets.CLOUD_TOKEN }}\n`],
  ["FORBIDDEN_REMOTE_OPERATION", `${valid}\n      - run: git push origin HEAD\n`]
];

describe("PR quality-gate workflow contract", () => {
  it("accepts only the minimal trusted workflow", () => {
    expect(validateWorkflowContract(valid)).toEqual([]);
  });

  it.each(mutationCases)("returns %s for a security regression", (code, source) => {
    expect(validateWorkflowContract(source).map((item) => item.code)).toContain(code);
  });

  it("keeps the committed workflow inside the minimal security contract", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const workflow = resolve(
      here,
      "../../../../.github/workflows/pr-quality-gate.yml"
    );

    expect(validateWorkflowContract(readFileSync(workflow, "utf8"))).toEqual([]);
  });
});
