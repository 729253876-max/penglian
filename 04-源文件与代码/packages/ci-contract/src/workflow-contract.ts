import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

export type WorkflowContractCode =
  | "INVALID_YAML"
  | "FORBIDDEN_TRIGGER"
  | "MISSING_TRIGGER"
  | "EXCESS_PERMISSION"
  | "FLOATING_ACTION"
  | "UNAPPROVED_ACTION"
  | "UNAPPROVED_JOB"
  | "UNAPPROVED_JOB_CONFIGURATION"
  | "UNAPPROVED_COMMAND"
  | "UNAPPROVED_STEP_CONFIGURATION"
  | "WRONG_RUNNER"
  | "WRONG_NODE"
  | "WRONG_NPM"
  | "WRONG_CACHE_PATH"
  | "WRONG_CHECKOUT"
  | "WRONG_WORKDIR"
  | "FORBIDDEN_INSTALL_SCRIPT"
  | "MISSING_GATE"
  | "GATE_ORDER"
  | "FILTERED_TESTS"
  | "FORBIDDEN_SECRET"
  | "FORBIDDEN_REMOTE_OPERATION"
  | "FORBIDDEN_REMOTE_OPERATION_BLOCK"
  | "FORBIDDEN_REMOTE_OPERATION_FOLDED";

export interface WorkflowContractError {
  code: WorkflowContractCode;
  message: string;
}

const PROJECT_DIRECTORY = "04-源文件与代码";
const REQUIRED_RUNS = [
  "npm.cmd ci --ignore-scripts",
  "npm.cmd run typecheck",
  "npm.cmd test -- --run",
  "npm.cmd run verify:miniprogram-runtime",
  "npm.cmd run build:wechat -w @photo-ai/miniprogram",
  "git diff --check origin/master...HEAD"
] as const;
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@7c2c68d20d402ed6a201ada70a81341941093140";
const ALLOWED_ACTIONS = new Set([CHECKOUT_ACTION, SETUP_NODE_ACTION]);
const TOOLCHAIN_COMMAND = `if ($(node --version) -ne "v24.18.0") {
  Write-Error "Expected Node.js v24.18.0, got $((node --version))"
  exit 1
}
if ($(npm.cmd --version) -ne "11.16.0") {
  Write-Error "Expected npm 11.16.0, got $((npm.cmd --version))"
  exit 1
}`;
const ENVIRONMENT_REPORT_COMMAND = `Write-Host 'MySQL integration: NOT ACCEPTED (MYSQL_INTEGRATION_URL is intentionally absent).'
Write-Host 'Object storage/COS: NOT ACCEPTED (credentials are intentionally absent).'`;
const ALLOWED_RUNS = [TOOLCHAIN_COMMAND, ...REQUIRED_RUNS.slice(0, 1), ENVIRONMENT_REPORT_COMMAND, ...REQUIRED_RUNS.slice(1)] as const;
const REMOTE_OPERATION_PATTERN = /\b(deploy|publish|migrate|curl|Invoke-WebRequest|git\s+push)\b/i;
const REAL_SERVICE_VARIABLES = new Set([
  "MYSQL_INTEGRATION_URL",
  "COS_SECRET",
  "STS_SECRET",
  "MODEL_API_KEY"
]);

interface ExpectedActionStep {
  readonly kind: "action";
  readonly uses: string;
  readonly with: Readonly<Record<string, string | number>>;
}

interface ExpectedRunStep {
  readonly kind: "run";
  readonly run: string;
  readonly workingDirectory: string;
  readonly name?: string;
  readonly shell?: string;
  readonly blockLiteral?: boolean;
}

const EXPECTED_STEPS: readonly (ExpectedActionStep | ExpectedRunStep)[] = [
  {
    kind: "action",
    uses: CHECKOUT_ACTION,
    with: {
      "fetch-depth": 0,
      ref: "${{ github.event.pull_request.head.sha || github.sha }}"
    }
  },
  {
    kind: "action",
    uses: SETUP_NODE_ACTION,
    with: {
      "node-version": "24.18.0",
      cache: "npm",
      "cache-dependency-path": "04-源文件与代码/package-lock.json"
    }
  },
  {
    kind: "run",
    name: "Verify toolchain versions",
    shell: "pwsh",
    run: TOOLCHAIN_COMMAND,
    workingDirectory: PROJECT_DIRECTORY,
    blockLiteral: true
  },
  { kind: "run", run: REQUIRED_RUNS[0] ?? "", workingDirectory: PROJECT_DIRECTORY },
  {
    kind: "run",
    name: "Report non-accepted environments",
    shell: "pwsh",
    run: ENVIRONMENT_REPORT_COMMAND,
    workingDirectory: PROJECT_DIRECTORY,
    blockLiteral: true
  },
  ...REQUIRED_RUNS.slice(1, -1).map((run) => ({
    kind: "run" as const,
    run,
    workingDirectory: PROJECT_DIRECTORY
  })),
  {
    kind: "run",
    run: REQUIRED_RUNS[REQUIRED_RUNS.length - 1] ?? "",
    workingDirectory: "."
  }
];

function add(
  errors: WorkflowContractError[],
  condition: boolean,
  code: WorkflowContractCode,
  message: string
) {
  if (condition) errors.push({ code, message });
}

function normaliseCommand(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

function mapKeys(map: YAMLMap): string[] | undefined {
  const keys: string[] = [];
  for (const pair of map.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") return undefined;
    keys.push(pair.key.value);
  }
  return keys;
}

function hasExactKeys(map: YAMLMap, expected: readonly string[]) {
  const keys = mapKeys(map);
  return !!keys && keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function mapValue(map: YAMLMap, key: string): unknown {
  return map.get(key, true);
}

function scalarValue(map: YAMLMap, key: string): unknown {
  const value = mapValue(map, key);
  return isScalar(value) ? value.value : undefined;
}

function mapValueAsMap(map: YAMLMap, key: string): YAMLMap | undefined {
  const value = mapValue(map, key);
  return isMap(value) ? value : undefined;
}

function mapValueAsSequence(map: YAMLMap, key: string) {
  const value = mapValue(map, key);
  return isSeq(value) ? value : undefined;
}

function sequenceValues(sequence: ReturnType<typeof mapValueAsSequence>): unknown[] | undefined {
  if (!sequence) return undefined;
  const values: unknown[] = [];
  for (const item of sequence.items) {
    if (!isScalar(item)) return undefined;
    values.push(item.value);
  }
  return values;
}

function containsForbiddenSecret(node: unknown): boolean {
  if (isScalar(node)) {
    return typeof node.value === "string" && /\$\{\{\s*secrets\./.test(node.value);
  }
  if (isSeq(node)) return node.items.some((item) => containsForbiddenSecret(item));
  if (!isMap(node)) return false;
  return node.items.some((pair) => {
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    return (
      (typeof key === "string" && REAL_SERVICE_VARIABLES.has(key)) ||
      containsForbiddenSecret(pair.value)
    );
  });
}

function validateTriggers(root: YAMLMap, errors: WorkflowContractError[]) {
  const triggers = mapValueAsMap(root, "on");
  if (!triggers) {
    add(errors, true, "MISSING_TRIGGER", "master pull_request and workflow_dispatch are required");
    return;
  }
  const keys = mapKeys(triggers);
  add(
    errors,
    !keys || keys.some((key) => key !== "pull_request" && key !== "workflow_dispatch"),
    "FORBIDDEN_TRIGGER",
    "only pull_request and workflow_dispatch triggers are allowed"
  );
  const pullRequest = mapValueAsMap(triggers, "pull_request");
  const branches = pullRequest ? sequenceValues(mapValueAsSequence(pullRequest, "branches")) : undefined;
  add(
    errors,
    !pullRequest || !hasExactKeys(pullRequest, ["branches"]) || JSON.stringify(branches) !== JSON.stringify(["master"]) || !triggers.has("workflow_dispatch") || scalarValue(triggers, "workflow_dispatch") !== null,
    "MISSING_TRIGGER",
    "master pull_request and workflow_dispatch are required"
  );
}

function validatePermissions(root: YAMLMap, errors: WorkflowContractError[]) {
  const permissions = mapValueAsMap(root, "permissions");
  add(
    errors,
    !permissions || !hasExactKeys(permissions, ["contents"]) || scalarValue(permissions, "contents") !== "read",
    "EXCESS_PERMISSION",
    "only contents: read is allowed"
  );
}

function remoteOperationCode(step: YAMLMap): WorkflowContractCode | undefined {
  const run = mapValue(step, "run");
  if (!isScalar(run) || typeof run.value !== "string" || !REMOTE_OPERATION_PATTERN.test(run.value)) return undefined;
  if (run.type === "BLOCK_LITERAL") return "FORBIDDEN_REMOTE_OPERATION_BLOCK";
  if (run.type === "BLOCK_FOLDED") return "FORBIDDEN_REMOTE_OPERATION_FOLDED";
  return "FORBIDDEN_REMOTE_OPERATION";
}

function validateActionStep(step: YAMLMap, expected: ExpectedActionStep, errors: WorkflowContractError[]) {
  const uses = scalarValue(step, "uses");
  add(errors, typeof uses !== "string" || !/@[0-9a-f]{40}$/.test(uses), "FLOATING_ACTION", "every action must use a full commit SHA");
  add(errors, typeof uses !== "string" || !ALLOWED_ACTIONS.has(uses), "UNAPPROVED_ACTION", "only the two reviewed action commits are allowed");
  add(errors, !hasExactKeys(step, ["uses", "with"]), "UNAPPROVED_STEP_CONFIGURATION", "action steps may only contain the reviewed uses and with fields");
  const withValues = mapValueAsMap(step, "with");
  const expectedKeys = Object.keys(expected.with);
  const hasExpectedWith = !!withValues && hasExactKeys(withValues, expectedKeys) && expectedKeys.every((key) => scalarValue(withValues, key) === expected.with[key]);
  if (expected.uses === CHECKOUT_ACTION) {
    add(errors, uses !== CHECKOUT_ACTION || !hasExpectedWith, "WRONG_CHECKOUT", "checkout must use the PR head with complete history");
    return;
  }
  add(errors, !withValues || scalarValue(withValues, "node-version") !== "24.18.0", "WRONG_NODE", "Node.js 24.18.0 is required");
  add(errors, !withValues || scalarValue(withValues, "cache-dependency-path") !== "04-源文件与代码/package-lock.json", "WRONG_CACHE_PATH", "the project lockfile must key npm cache");
  add(errors, uses !== SETUP_NODE_ACTION || !hasExpectedWith, "UNAPPROVED_STEP_CONFIGURATION", "setup-node must use the frozen cache configuration");
}

function validateRunStep(step: YAMLMap, expected: ExpectedRunStep | undefined, errors: WorkflowContractError[]) {
  const runNode = mapValue(step, "run");
  const run = isScalar(runNode) && typeof runNode.value === "string" ? normaliseCommand(runNode.value) : undefined;
  const remoteCode = remoteOperationCode(step);
  if (remoteCode) add(errors, true, remoteCode, "deployment, download and remote-write commands are forbidden");
  if (run === "npm.cmd ci") add(errors, true, "FORBIDDEN_INSTALL_SCRIPT", "npm ci must disable dependency install scripts");
  if (typeof run === "string" && run.startsWith("npm.cmd test") && run !== "npm.cmd test -- --run") add(errors, true, "FILTERED_TESTS", "Vitest must run without file or test filters");
  add(errors, typeof run !== "string" || !ALLOWED_RUNS.includes(run as (typeof ALLOWED_RUNS)[number]), "UNAPPROVED_COMMAND", "only the frozen workflow commands are allowed");
  if (!expected) return;
  const expectedKeys = [...(expected.name ? ["name"] : []), ...(expected.shell ? ["shell"] : []), "run", "working-directory"];
  add(errors, !hasExactKeys(step, expectedKeys), "UNAPPROVED_STEP_CONFIGURATION", "run steps may only contain their frozen fields");
  add(errors, scalarValue(step, "working-directory") !== expected.workingDirectory, "WRONG_WORKDIR", `${expected.run} has the wrong working directory`);
  add(errors, run !== expected.run, "UNAPPROVED_COMMAND", "workflow commands must retain their frozen order and content");
  if (expected.name) add(errors, scalarValue(step, "name") !== expected.name, "UNAPPROVED_STEP_CONFIGURATION", "named steps must retain their approved name");
  if (expected.shell) add(errors, scalarValue(step, "shell") !== expected.shell, "UNAPPROVED_STEP_CONFIGURATION", "named steps must retain their approved shell");
  if (expected.blockLiteral) add(errors, !isScalar(runNode) || runNode.type !== "BLOCK_LITERAL", "UNAPPROVED_STEP_CONFIGURATION", "approved multi-line commands must remain literal blocks");
  if (expected.run === TOOLCHAIN_COMMAND) {
    add(errors, run?.includes('"v24.18.0"') !== true, "WRONG_NODE", "Node.js 24.18.0 is required");
    add(errors, run?.includes('"11.16.0"') !== true, "WRONG_NPM", "npm 11.16.0 is required");
  }
}

function validateJobs(root: YAMLMap, errors: WorkflowContractError[]) {
  const jobs = mapValueAsMap(root, "jobs");
  const jobKeys = jobs ? mapKeys(jobs) : undefined;
  add(errors, !jobs || !jobKeys || jobKeys.length !== 1 || jobKeys[0] !== "quality-gate", "UNAPPROVED_JOB", "only the quality-gate job is allowed");
  const qualityGate = jobs ? mapValueAsMap(jobs, "quality-gate") : undefined;
  if (!qualityGate) return;
  add(errors, qualityGate.has("permissions"), "EXCESS_PERMISSION", "job-level permissions are forbidden");
  add(errors, !hasExactKeys(qualityGate, ["runs-on", "timeout-minutes", "steps"]) || scalarValue(qualityGate, "timeout-minutes") !== 30, "UNAPPROVED_JOB_CONFIGURATION", "quality-gate configuration must remain frozen");
  add(errors, scalarValue(qualityGate, "runs-on") !== "windows-latest", "WRONG_RUNNER", "windows-latest is required");
  const steps = mapValueAsSequence(qualityGate, "steps");
  if (!steps) {
    add(errors, true, "UNAPPROVED_JOB_CONFIGURATION", "quality-gate requires the frozen steps");
    return;
  }
  const runCommands: string[] = [];
  for (let index = 0; index < steps.items.length; index += 1) {
    const step = steps.items[index];
    if (!isMap(step)) {
      add(errors, true, "UNAPPROVED_STEP_CONFIGURATION", "every workflow step must be a mapping");
      continue;
    }
    const expected = EXPECTED_STEPS[index];
    if (step.has("uses")) {
      if (!expected || expected.kind !== "action") {
        validateActionStep(step, { kind: "action", uses: "", with: {} }, errors);
        add(errors, true, "UNAPPROVED_STEP_CONFIGURATION", "actions must retain their frozen order");
      } else validateActionStep(step, expected, errors);
      if (step.has("run")) validateRunStep(step, undefined, errors);
      continue;
    }
    if (step.has("run")) {
      const value = scalarValue(step, "run");
      if (typeof value === "string") runCommands.push(normaliseCommand(value));
      validateRunStep(step, expected?.kind === "run" ? expected : undefined, errors);
      continue;
    }
    add(errors, true, "UNAPPROVED_STEP_CONFIGURATION", "each workflow step must use an approved action or command");
  }
  add(errors, REQUIRED_RUNS.some((command) => !runCommands.includes(command)), "MISSING_GATE", "all six install and gate commands are required");
  const requiredRunsInActualOrder = runCommands.filter((run) => REQUIRED_RUNS.includes(run as (typeof REQUIRED_RUNS)[number]));
  add(errors, JSON.stringify(requiredRunsInActualOrder) !== JSON.stringify(REQUIRED_RUNS), "GATE_ORDER", "install and five gates must stay in order");
  add(errors, steps.items.length !== EXPECTED_STEPS.length, "UNAPPROVED_STEP_CONFIGURATION", "workflow steps must retain their frozen count and order");
}

export function validateWorkflowContract(source: string): WorkflowContractError[] {
  let document;
  try {
    document = parseDocument(source, { merge: false, prettyErrors: false, schema: "core", strict: true, stringKeys: true, uniqueKeys: true, version: "1.2" });
  } catch {
    return [{ code: "INVALID_YAML", message: "workflow must be valid YAML" }];
  }
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    return [{ code: "INVALID_YAML", message: "workflow must be valid YAML" }];
  }
  const root = document.contents;
  const errors: WorkflowContractError[] = [];
  add(errors, !hasExactKeys(root, ["name", "on", "permissions", "jobs"]) || scalarValue(root, "name") !== "PR Quality Gate", "UNAPPROVED_JOB_CONFIGURATION", "workflow top-level configuration must remain frozen");
  validateTriggers(root, errors);
  validatePermissions(root, errors);
  add(errors, containsForbiddenSecret(root), "FORBIDDEN_SECRET", "secrets and real-service credential variables are forbidden");
  validateJobs(root, errors);
  return errors;
}
