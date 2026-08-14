export type WorkflowContractCode =
  | "FORBIDDEN_TRIGGER"
  | "MISSING_TRIGGER"
  | "EXCESS_PERMISSION"
  | "FLOATING_ACTION"
  | "UNAPPROVED_ACTION"
  | "WRONG_RUNNER"
  | "WRONG_NODE"
  | "WRONG_CACHE_PATH"
  | "WRONG_CHECKOUT"
  | "WRONG_WORKDIR"
  | "FORBIDDEN_INSTALL_SCRIPT"
  | "MISSING_GATE"
  | "GATE_ORDER"
  | "FILTERED_TESTS"
  | "FORBIDDEN_SECRET"
  | "FORBIDDEN_REMOTE_OPERATION";

export interface WorkflowContractError {
  code: WorkflowContractCode;
  message: string;
}

const REQUIRED_RUNS = [
  "npm.cmd ci --ignore-scripts",
  "npm.cmd run typecheck",
  "npm.cmd test -- --run",
  "npm.cmd run verify:miniprogram-runtime",
  "npm.cmd run build:wechat -w @photo-ai/miniprogram",
  "git diff --check origin/master...HEAD"
] as const;

const ALLOWED_ACTIONS = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@7c2c68d20d402ed6a201ada70a81341941093140"
]);

function add(
  errors: WorkflowContractError[],
  condition: boolean,
  code: WorkflowContractCode,
  message: string
) {
  if (condition) errors.push({ code, message });
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateWorkflowContract(source: string): WorkflowContractError[] {
  const text = source.replace(/\r\n/g, "\n");
  const errors: WorkflowContractError[] = [];

  add(
    errors,
    /(^|\n)\s*pull_request_target\s*:/.test(text),
    "FORBIDDEN_TRIGGER",
    "pull_request_target is forbidden"
  );
  add(
    errors,
    !/(^|\n)  pull_request:\n    branches:\n      - master\n/.test(text) ||
      !/(^|\n)  workflow_dispatch:\s*\n/.test(text),
    "MISSING_TRIGGER",
    "master pull_request and workflow_dispatch are required"
  );

  const permissions = text
    .match(/(^|\n)permissions:\n((?:  [^\n]+\n)+)/)?.[2]
    ?.trim();
  add(
    errors,
    permissions !== "contents: read",
    "EXCESS_PERMISSION",
    "only contents: read is allowed"
  );
  add(
    errors,
    !/(^|\n)    runs-on: windows-latest\n/.test(text),
    "WRONG_RUNNER",
    "windows-latest is required"
  );
  add(
    errors,
    !/(^|\n)          node-version: 24\n/.test(text),
    "WRONG_NODE",
    "Node.js 24 is required"
  );
  add(
    errors,
    !/(^|\n)          cache-dependency-path: 04-源文件与代码\/package-lock\.json\n/.test(text),
    "WRONG_CACHE_PATH",
    "the project lockfile must key npm cache"
  );
  add(
    errors,
    !text.includes(
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n" +
        "        with:\n" +
        "          fetch-depth: 0\n" +
        "          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n"
    ),
    "WRONG_CHECKOUT",
    "checkout must use the PR head with complete history"
  );

  const uses = [...text.matchAll(/^\s+-\s+uses:\s*(\S+)\s*$/gm)].map(
    (match) => match[1] ?? ""
  );
  add(
    errors,
    uses.some((item) => !/@[0-9a-f]{40}$/.test(item)),
    "FLOATING_ACTION",
    "every action must use a full commit SHA"
  );
  add(
    errors,
    uses.length !== 2 || uses.some((item) => !ALLOWED_ACTIONS.has(item)),
    "UNAPPROVED_ACTION",
    "only the two reviewed action commits are allowed"
  );

  const runs = [...text.matchAll(/^\s+-\s+run:\s+(?!\|)(.+?)\s*$/gm)].map(
    (match) => match[1] ?? ""
  );
  add(
    errors,
    REQUIRED_RUNS.some((command) => !runs.includes(command)),
    "MISSING_GATE",
    "all six install and gate commands are required"
  );
  const requiredRunsInActualOrder = runs.filter((run) =>
    REQUIRED_RUNS.includes(run as (typeof REQUIRED_RUNS)[number])
  );
  add(
    errors,
    JSON.stringify(requiredRunsInActualOrder) !== JSON.stringify(REQUIRED_RUNS),
    "GATE_ORDER",
    "install and five gates must stay in order"
  );
  add(
    errors,
    runs.some(
      (run) => run.startsWith("npm.cmd test") && run !== "npm.cmd test -- --run"
    ),
    "FILTERED_TESTS",
    "Vitest must run without file or test filters"
  );
  add(
    errors,
    runs.includes("npm.cmd ci"),
    "FORBIDDEN_INSTALL_SCRIPT",
    "npm ci must disable dependency install scripts"
  );

  for (const command of REQUIRED_RUNS) {
    const expectedDirectory =
      command === "git diff --check origin/master...HEAD"
        ? "."
        : "04-源文件与代码";
    const commandPattern = escapeRegex(command);
    const directoryPattern = escapeRegex(expectedDirectory);
    add(
      errors,
      !new RegExp(
        `run: ${commandPattern}\\n\\s+working-directory: ${directoryPattern}\\n`
      ).test(text),
      "WRONG_WORKDIR",
      `${command} has the wrong working directory`
    );
  }

  add(
    errors,
    /\$\{\{\s*secrets\.|(^|\n)\s+(MYSQL_INTEGRATION_URL|COS_SECRET|STS_SECRET|MODEL_API_KEY)\s*:/m.test(
      text
    ),
    "FORBIDDEN_SECRET",
    "secrets and real-service credential variables are forbidden"
  );
  add(
    errors,
    /(^|\n)\s+-\s+run:\s+.*\b(deploy|publish|migrate|curl|Invoke-WebRequest|git\s+push)\b/im.test(
      text
    ),
    "FORBIDDEN_REMOTE_OPERATION",
    "deployment, download and remote-write commands are forbidden"
  );

  return errors;
}
