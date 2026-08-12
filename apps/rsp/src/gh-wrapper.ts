import { spawn } from "node:child_process";
import { startChildProcessTimer } from "./overhead-budget.js";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { type RspMintMeta, type RspLossLevel } from "./elision-store.js";
import { readGhConditionalJson } from "./gh-conditional.js";
import { isGhBatchCommand, runGhBatchCommand } from "./gh-batch.js";
import { runGhApiRead } from "./gh-api-wrapper.js";
import { recoveryInstruction, type RecordedGitContract } from "./git-wrapper.js";
import { extractQueryArg, filterRows, withHelp } from "./output-levers.js";
import { classifyWrappedFailure, renderStructuredError } from "./structured-error.js";

export type GhKind = "pr" | "issue" | "run";
export type GhAction = "list" | "view" | "combined";

export interface GhRenderOptions {
  level: RspLossLevel;
  store?: RspMintStore;
}

interface RspMintStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

export interface GhRenderResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  payload?: JsonObject;
  mintedHandle?: string;
  bytesElided?: number;
  rowsElided?: number;
  rawOutput?: Buffer;
}

interface GhCommand {
  kind: GhKind;
  action: GhAction;
  target?: string;
  full: boolean;
  wide: boolean;
  fields: Set<string>;
  passthrough: string[];
  query?: string;
}

type MachineGhAction = Exclude<GhAction, "combined">;

const DEFAULT_FIELDS: Record<`${GhKind}:${MachineGhAction}`, string[]> = {
  "pr:list": ["number", "title", "state", "isDraft"],
  "pr:view": ["number", "title", "state", "body"],
  "issue:list": ["number", "title", "state", "labels"],
  "issue:view": ["number", "title", "state", "body"],
  "run:list": ["databaseId", "name", "status", "conclusion"],
  "run:view": ["databaseId", "name", "status", "conclusion", "jobs"],
};

const WIDE_FIELDS: Record<`${GhKind}:${MachineGhAction}`, string[]> = {
  "pr:list": ["number", "title", "state", "isDraft", "author", "labels", "url", "updatedAt"],
  "pr:view": ["number", "title", "state", "body", "author", "labels", "url", "baseRefName", "headRefName"],
  "issue:list": ["number", "title", "state", "labels", "author", "url", "updatedAt"],
  "issue:view": ["number", "title", "state", "body", "author", "labels", "url", "updatedAt"],
  "run:list": ["databaseId", "name", "status", "conclusion", "event", "headBranch", "workflowName", "createdAt"],
  "run:view": ["databaseId", "name", "status", "conclusion", "event", "headBranch", "workflowName", "createdAt", "jobs", "url"],
};

const BODY_LIMIT = 160;
const LOG_LIMIT = 160;

const SELECTABLE_LIST_FIELDS: Record<`${GhKind}:list`, readonly string[]> = {
  "pr:list": ["number", "title", "state", "draft", "author", "labels", "url", "updated"],
  "issue:list": ["number", "title", "state", "labels", "author", "url", "updated"],
  "run:list": ["id", "name", "status", "conclusion", "event", "branch", "workflow", "created"],
};

export async function runGhWrapper(argv: readonly string[], options: GhRenderOptions): Promise<GhRenderResult> {
  if (isGhBatchCommand(argv)) return await runGhBatchCommand(argv);
  if (argv[0] === "gh" && argv[1] === "api") return await runGhApiRead(argv);
  const command = parseGhCommand(argv);
  const contract = await collectGhContract(command);
  return renderGhContract(argv, contract, options);
}

export { parseGhApiRead } from "./gh-api-wrapper.js";

export async function renderGhContract(
  commandArgv: readonly string[],
  contract: RecordedGitContract,
  options: GhRenderOptions,
): Promise<GhRenderResult> {
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    const error = classifyWrappedFailure(commandArgv.join(" "), contract.stdout, contract.stderr);
    return {
      stdout: renderStructuredError(error),
      stderr: Buffer.from(contract.stderr),
      status: error.exitCode ?? 1,
      signal: contract.signal,
    };
  }

  const command = parseGhCommand(commandArgv);
  const parsed = parseJson(contract.stdout);
  const payload = renderGhPayload(command, commandArgv, parsed);
  if (typeof payload === "string") {
    return {
      stdout: Buffer.from(payload),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
    };
  }

  const handleRequest = findHandleRequest(payload);
  if (handleRequest) {
    if (!options.store) throw new Error("truncated gh output requires an elision store");
    const handle = await options.store.mint(Buffer.from(handleRequest.original), {
      command: commandArgv.join(" "),
      loss: { level: command.full ? "brief" : options.level, bytes_elided: handleRequest.bytes },
    });
    handleRequest.target.truncated.handle = handle;
  }

  const mintedTextHandle = handleRequest?.target.truncated.handle || undefined;
  const fullToon = encode(payload);
  if (options.level !== "terse") {
    return {
      stdout: Buffer.from(fullToon),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
      payload,
      mintedHandle: mintedTextHandle,
      bytesElided: handleRequest?.bytes,
    };
  }

  const terse = tersePayload(payload);
  if (!terse) {
    return {
      stdout: Buffer.from(fullToon),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
      payload,
      mintedHandle: mintedTextHandle,
      bytesElided: handleRequest?.bytes,
    };
  }

  const bytesElided = Buffer.byteLength(fullToon);
  const handle = await options.store?.mint(Buffer.from(fullToon), {
    command: commandArgv.join(" "),
    loss: { level: "terse", bytes_elided: bytesElided },
  });
  if (!handle) throw new Error("terse gh output requires an elision store");

  const marker = `… elided ${terse.rowsElided} rows (+${bytesElided}) — ${recoveryInstruction(handle)}\n`;
  return {
    stdout: Buffer.from(`${encode(terse.payload)}\n${marker}`),
    stderr: Buffer.from(contract.stderr),
    status: contract.status,
    signal: contract.signal,
    payload: terse.payload,
    mintedHandle: handle,
    bytesElided,
    rowsElided: terse.rowsElided,
    rawOutput: Buffer.from(fullToon),
  };
}

function parseGhCommand(argv: readonly string[]): GhCommand {
  const parsed = extractQueryArg(argv);
  if (parsed.argv[0] !== "gh") throw new Error("expected rsp gh <surface> <subcommand>");
  const kind = parsed.argv[1];
  const action = parsed.argv[2];
  if (!(kind === "pr" || kind === "issue" || kind === "run")) throw new Error(`unsupported gh surface: ${kind ?? ""}`);
  const combined = kind === "pr" && action && action !== "list" && action !== "view";
  if (!(action === "list" || action === "view" || combined)) throw new Error(`unsupported gh subcommand: ${action ?? ""}`);
  const parsedKind: GhKind = kind;

  const passthrough: string[] = [];
  let full = false;
  let wide = false;
  let fields = new Set<string>();
  const tail = parsed.argv.slice(3);
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i] ?? "";
    if (arg === "--full") full = true;
    else if (arg === "--wide") wide = true;
    else if (arg === "--fields") fields = parseFieldsValue(tail[++i] ?? "");
    else if (arg.startsWith("--fields=")) fields = parseFieldsValue(arg.slice("--fields=".length));
    else passthrough.push(arg);
  }
  const parsedAction: GhAction = combined ? "combined" : action === "list" ? "list" : "view";
  const command: GhCommand = { kind: parsedKind, action: parsedAction, target: combined ? action : undefined, full, wide, fields, passthrough, query: parsed.query };
  validateSelectedFields(command);
  return command;
}

function machineArgs(command: GhCommand): string[] {
  if (command.action === "combined") throw new Error("combined gh command uses multiple machine calls");
  const key = `${command.kind}:${command.action}` as const;
  const fields = command.wide || command.fields.size > 0 ? WIDE_FIELDS[key] : DEFAULT_FIELDS[key];
  return [command.kind, command.action, ...command.passthrough, "--json", fields.join(",")];
}

function parseFieldsValue(value: string): Set<string> {
  return new Set(value.split(",").map((field) => field.trim()).filter(Boolean));
}

function validateSelectedFields(command: GhCommand): void {
  if (command.fields.size === 0) return;
  if (command.action !== "list") throw new GhUsageError(command, `--fields is supported for list outputs`);
  const key = `${command.kind}:list` as const;
  const allowed = SELECTABLE_LIST_FIELDS[key];
  for (const field of command.fields) {
    if (!allowed.includes(field)) throw new GhUsageError(command, `unknown field: ${field}`, allowed);
  }
}

async function collectGhContract(command: GhCommand): Promise<RecordedGitContract> {
  if (command.action === "combined") return await collectCombinedPrContract(command);
  const request = ghApiRequest(command);
  if (!request) return await collectRawGh(machineArgs(command));
  const response = await readGhConditionalJson({
    ...request,
    command: ["gh", ...machineArgs(command)].join(" "),
  });
  if (response.status !== 0) {
    return { stdout: response.stdout, stderr: response.stderr, status: response.status, signal: null };
  }
  return {
    stdout: JSON.stringify(await normalizeGhApiPayload(command, response.stdout)),
    stderr: response.stderr,
    status: 0,
    signal: null,
  };
}

async function collectCombinedPrContract(command: GhCommand): Promise<RecordedGitContract> {
  const target = command.target ?? "";
  const [view, checks, comments] = await Promise.all([
    readGhConditionalJson({ path: `repos/{owner}/{repo}/pulls/${target}`, command: `gh pr view ${target}` }),
    readGhConditionalJson({ path: `repos/{owner}/{repo}/pulls/${target}/commits`, command: `gh pr checks ${target}` }),
    readGhConditionalJson({ path: `repos/{owner}/{repo}/issues/${target}/comments`, command: `gh pr view ${target} --comments` }),
  ]);
  const failed = [view, checks, comments].find((result) => (result.status ?? 0) !== 0);
  if (failed) return { stdout: failed.stdout, stderr: failed.stderr, status: failed.status, signal: null };
  const viewRow = normalizePrView(parseJson(view.stdout));
  return {
    stdout: JSON.stringify({
      view: viewRow,
      checks: [],
      comments: { comments: arrayOfRecords(parseJson(comments.stdout)).map(normalizeComment) },
    }),
    stderr: [view.stderr, checks.stderr, comments.stderr].filter(Boolean).join(""),
    status: 0,
    signal: null,
  };
}

function ghApiRequest(command: GhCommand): { path: string; params?: Record<string, string | number | boolean | undefined> } | null {
  const target = firstPositional(command.passthrough);
  const limit = numberOption(command.passthrough, "--limit") ?? 30;
  const state = stringOption(command.passthrough, "--state") ?? "open";
  switch (`${command.kind}:${command.action}`) {
    case "pr:list":
      return { path: "repos/{owner}/{repo}/pulls", params: { state, per_page: limit } };
    case "pr:view":
      return target ? { path: `repos/{owner}/{repo}/pulls/${target}` } : null;
    case "issue:list":
      return {
        path: "repos/{owner}/{repo}/issues",
        params: { state, labels: stringOption(command.passthrough, "--label"), per_page: limit },
      };
    case "issue:view":
      return target ? { path: `repos/{owner}/{repo}/issues/${target}` } : null;
    case "run:list":
      return { path: "repos/{owner}/{repo}/actions/runs", params: { per_page: limit } };
    case "run:view":
      return target ? { path: `repos/{owner}/{repo}/actions/runs/${target}` } : null;
    default:
      return null;
  }
}

async function normalizeGhApiPayload(command: GhCommand, raw: string): Promise<unknown> {
  const parsed = parseJson(raw);
  switch (`${command.kind}:${command.action}`) {
    case "pr:list":
      return arrayOfRecords(parsed).map(normalizePrListItem);
    case "pr:view":
      return normalizePrView(parsed);
    case "issue:list":
      return arrayOfRecords(parsed).filter((row) => !isRecord(row.pull_request)).map(normalizeIssue);
    case "issue:view":
      return normalizeIssue(parsed);
    case "run:list":
      return {
        items: arrayOfRecords(recordOf(parsed).workflow_runs).map(normalizeRun),
        total: numberField(recordOf(parsed), "total_count"),
      };
    case "run:view": {
      const run = normalizeRun(parsed);
      const target = firstPositional(command.passthrough);
      if (!target) return run;
      const jobs = await readGhConditionalJson({
        path: `repos/{owner}/{repo}/actions/runs/${target}/jobs`,
        command: `gh run view ${target} jobs`,
      });
      return {
        ...run,
        jobs: jobs.status === 0 ? arrayOfRecords(recordOf(parseJson(jobs.stdout)).jobs).map(normalizeJob) : [],
      };
    }
    default:
      return parsed;
  }
}

function normalizePrListItem(value: unknown): JsonObject {
  const row = recordOf(value);
  return {
    number: numberField(row, "number"),
    title: stringField(row, "title"),
    state: stringField(row, "state").toUpperCase(),
    isDraft: Boolean(row.draft),
    author: normalizeUser(row.user),
    labels: arrayOfRecords(row.labels).map((label) => ({ name: stringField(label, "name") })),
    url: stringField(row, "html_url"),
    updatedAt: stringField(row, "updated_at"),
    body: stringField(row, "body"),
    baseRefName: stringField(recordOf(row.base), "ref"),
    headRefName: stringField(recordOf(row.head), "ref"),
  };
}

function normalizePrView(value: unknown): JsonObject {
  return normalizePrListItem(value);
}

function normalizeIssue(value: unknown): JsonObject {
  const row = recordOf(value);
  return {
    number: numberField(row, "number"),
    title: stringField(row, "title"),
    state: stringField(row, "state").toUpperCase(),
    labels: arrayOfRecords(row.labels).map((label) => ({ name: stringField(label, "name") })),
    author: normalizeUser(row.user),
    url: stringField(row, "html_url"),
    updatedAt: stringField(row, "updated_at"),
    body: stringField(row, "body"),
  };
}

function normalizeRun(value: unknown): JsonObject {
  const row = recordOf(value);
  return {
    databaseId: numberField(row, "database_id") || numberField(row, "id"),
    name: stringField(row, "name") || stringField(row, "display_title"),
    status: stringField(row, "status").toUpperCase(),
    conclusion: stringField(row, "conclusion").toUpperCase(),
    event: stringField(row, "event"),
    headBranch: stringField(row, "head_branch"),
    workflowName: stringField(row, "workflow_name"),
    createdAt: stringField(row, "created_at"),
    url: stringField(row, "html_url"),
    jobs: [],
  };
}

function normalizeJob(value: unknown): JsonObject {
  const row = recordOf(value);
  return {
    name: stringField(row, "name"),
    status: stringField(row, "status").toUpperCase(),
    conclusion: stringField(row, "conclusion").toUpperCase(),
    log: "",
  };
}

function normalizeComment(value: unknown): JsonObject {
  const row = recordOf(value);
  return {
    author: normalizeUser(row.user),
    body: stringField(row, "body"),
    createdAt: stringField(row, "created_at"),
  };
}

function normalizeUser(value: unknown): JsonObject {
  const row = recordOf(value);
  return { login: stringField(row, "login") };
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function stringOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberOption(args: readonly string[], name: string): number | undefined {
  const value = stringOption(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function collectRawGh(args: readonly string[]): Promise<RecordedGitContract> {
  const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
  // The wrapped command's own runtime is never rsp's overhead (#2746).
  const stopChildTimer = startChildProcessTimer();
  child.once("close", stopChildTimer);
  child.once("error", stopChildTimer);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        status,
        signal,
      });
    });
  });
}

function renderGhPayload(command: GhCommand, commandArgv: readonly string[], parsed: unknown): JsonObject | string {
  const base = { command: commandArgv.join(" ") };
  switch (`${command.kind}:${command.action}`) {
    case "pr:list": {
      const list = listRecords(parsed, "prs");
      const rows = list.rows.map((row) => projectPr(row, command));
      const filteredRows = filterRows(rows, command.query);
      const aggregate = listAggregate(filteredRows.length, rows.length, list.total, command.query);
      if (filteredRows.length === 0) return emptyListPayload(base, command, "prs", aggregate, ["rsp gh issue list", "rsp gh pr list --query <title-or-label>"]);
      return helpIfQueried({ ...base, prs: filteredRows as JsonValue, aggregate, summary: `${countLabel(filteredRows.length, rows.length, command.query)} ${stateWord(filteredRows, "open")} PRs` }, command, ["rsp gh pr <number>", "rsp gh pr list --query <title-or-label>"]);
    }
    case "pr:view":
      return helpIfQueried({ ...base, pr: projectPrView(recordOf(parsed), command), summary: `PR #${numberField(recordOf(parsed), "number")}` }, command, ["rsp gh pr <number>", "rsp gh pr view <number> --full"]);
    case "pr:combined":
      return renderCombinedPrPayload(command, commandArgv, recordOf(parsed));
    case "issue:list": {
      const list = listRecords(parsed, "issues");
      const rows = list.rows.map((row) => projectIssue(row, command));
      const filteredRows = filterRows(rows, command.query);
      const aggregate = listAggregate(filteredRows.length, rows.length, list.total, command.query);
      if (filteredRows.length === 0) return emptyListPayload(base, command, "issues", aggregate, ["rsp gh issue list --state all", "rsp gh issue list --query <label-or-title>"]);
      return helpIfQueried({ ...base, issues: filteredRows as JsonValue, aggregate, summary: `${countLabel(filteredRows.length, rows.length, command.query)} ${stateWord(filteredRows, "open")} issues` }, command, ["rsp gh issue view <number>", "rsp gh issue list --query <label-or-title>"]);
    }
    case "issue:view":
      return helpIfQueried({ ...base, issue: projectIssueView(recordOf(parsed), command), summary: `issue #${numberField(recordOf(parsed), "number")}` }, command, ["rsp gh issue view <number> --full"]);
    case "run:list": {
      const list = listRecords(parsed, "runs");
      const rows = list.rows.map((row) => projectRun(row, command));
      const filteredRows = filterRows(rows, command.query);
      const aggregate = listAggregate(filteredRows.length, rows.length, list.total, command.query);
      if (filteredRows.length === 0) return emptyListPayload(base, command, "runs", aggregate, ["rsp gh run list --limit 20", "rsp gh run list --query <workflow-or-status>"]);
      return helpIfQueried({ ...base, runs: filteredRows as JsonValue, aggregate, summary: `${countLabel(filteredRows.length, rows.length, command.query)} runs` }, command, ["rsp gh run view <id>", "rsp gh run list --query <workflow-or-status>"]);
    }
    case "run:view":
      return helpIfQueried({ ...base, run: projectRunView(recordOf(parsed), command), summary: `run ${numberField(recordOf(parsed), "databaseId")}` }, command, ["rsp gh run view <id> --full"]);
  }
  throw new Error(`unsupported gh command: ${command.kind} ${command.action}`);
}

function renderCombinedPrPayload(command: GhCommand, commandArgv: readonly string[], parsed: Record<string, unknown>): JsonObject {
  const view = projectPrView(recordOf(parsed.view), { ...command, action: "view", wide: true });
  const checks = filterRows(arrayOfRecords(parsed.checks).map(projectCheck), command.query);
  const commentsSource = recordOf(parsed.comments).comments;
  const comments = filterRows(arrayOfRecords(commentsSource).map(projectComment).slice(-3), command.query);
  return withHelp({
    command: commandArgv.join(" "),
    pr: view,
    checks: checks as JsonValue,
    comments: comments as JsonValue,
    summary: `PR #${numberField(recordOf(parsed.view), "number")}: ${checks.length} checks, ${comments.length} comments`,
  }, ["rsp gh pr view <number> --full", "rsp gh pr <number> --query <check-or-comment>", "rsp gh run view <id>"]);
}

function projectCheck(row: Record<string, unknown>): JsonObject {
  return {
    name: stringField(row, "name"),
    state: stateClass(row),
    bucket: stringField(row, "bucket"),
    conclusion: stringField(row, "conclusion"),
    workflow: stringField(row, "workflow"),
    link: stringField(row, "link"),
  };
}

function projectComment(row: Record<string, unknown>): JsonObject {
  return {
    author: authorLogin(row.author),
    body: textField(row, "body", BODY_LIMIT, false),
    created: stringField(row, "createdAt"),
  };
}

function listRecords(parsed: unknown, key: "prs" | "issues" | "runs"): { rows: Record<string, unknown>[]; total?: number } {
  if (Array.isArray(parsed)) return { rows: arrayOfRecords(parsed) };
  const record = recordOf(parsed);
  const total = numberField(record, "total") || numberField(record, "total_count") || undefined;
  if (Array.isArray(record.items)) return { rows: arrayOfRecords(record.items), total };
  if (key === "runs" && Array.isArray(record.workflow_runs)) return { rows: arrayOfRecords(record.workflow_runs), total };
  return { rows: [] };
}

function listAggregate(returned: number, unfiltered: number, total: number | undefined, query?: string): JsonObject {
  const aggregate: JsonObject = { returned };
  if (typeof total === "number" && total > 0) aggregate.total = total;
  if (query) aggregate.unfiltered = unfiltered;
  return aggregate;
}

function emptyListPayload(
  base: JsonObject,
  command: GhCommand,
  key: "prs" | "issues" | "runs",
  aggregate: JsonObject,
  help: readonly string[],
): JsonObject {
  return withHelp({
    ...base,
    empty: true,
    scope: listScope(command),
    [key]: [],
    aggregate,
    summary: `0 ${listNoun(command)}`,
  }, help);
}

function listScope(command: GhCommand): string {
  const state = stringOption(command.passthrough, "--state") ?? "open";
  const query = command.query ? ` query=${command.query}` : "";
  if (command.kind === "pr") return `${state} PRs${query}`;
  if (command.kind === "issue") {
    const label = stringOption(command.passthrough, "--label");
    return `${state} issues${label ? ` label=${label}` : ""}${query}`;
  }
  const branch = stringOption(command.passthrough, "--branch") ?? stringOption(command.passthrough, "-b");
  const workflow = stringOption(command.passthrough, "--workflow") ?? stringOption(command.passthrough, "-w");
  return `workflow runs${branch ? ` branch=${branch}` : ""}${workflow ? ` workflow=${workflow}` : ""}${query}`;
}

function listNoun(command: GhCommand): string {
  const state = stringOption(command.passthrough, "--state") ?? "open";
  if (command.kind === "pr") return `${state} PRs`;
  if (command.kind === "issue") return `${state} issues`;
  return "runs";
}

function projectPr(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = {
    number: numberField(row, "number"),
    title: stringField(row, "title"),
    state: stateClass(row),
    draft: Boolean(row.isDraft),
  };
  addSelected(out, row, command, ["author", "labels", "url", "updated"]);
  return out;
}

function projectPrView(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = projectPr(row, command);
  out.body = textField(row, "body", BODY_LIMIT, command.full);
  if (command.wide) {
    out.base = stringField(row, "baseRefName");
    out.head = stringField(row, "headRefName");
  }
  return out;
}

function projectIssue(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = {
    number: numberField(row, "number"),
    title: stringField(row, "title"),
    state: stateClass(row),
    labels: labels(row.labels),
  };
  addSelected(out, row, command, ["author", "url", "updated"]);
  return out;
}

function projectIssueView(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = projectIssue(row, command);
  out.body = textField(row, "body", BODY_LIMIT, command.full);
  return out;
}

function projectRun(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = {
    id: numberField(row, "databaseId"),
    name: stringField(row, "name"),
    status: stateClass(row),
    conclusion: stringField(row, "conclusion"),
  };
  addSelected(out, row, command, ["event", "branch", "workflow", "created"]);
  return out;
}

function projectRunView(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = projectRun(row, command);
  const jobs = arrayOfRecords(row.jobs).map((job) => ({
    name: stringField(job, "name"),
    status: stateClass(job),
    conclusion: stringField(job, "conclusion"),
    log: textField(job, "log", LOG_LIMIT, command.full),
  }));
  out.jobs = jobs as JsonValue;
  return out;
}

function textField(row: Record<string, unknown>, field: string, limit: number, full: boolean): JsonValue {
  const value = stringField(row, field);
  if (full || Buffer.byteLength(value) <= limit) return value;
  const shown = value.slice(0, limit);
  const out = {
    preview: shown,
    truncated: {
      bytes: Buffer.byteLength(value),
      shown_bytes: Buffer.byteLength(shown),
      hint: "--full",
      handle: "",
    },
  };
  Object.defineProperty(out, "__rsp_original", { value, enumerable: false });
  return out;
}

function findHandleRequest(payload: JsonObject): { target: { truncated: { handle: string } }; original: string; bytes: number } | null {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isRecord(value)) {
      if (isRecord(value.truncated) && value.truncated.handle === "" && typeof value.preview === "string") {
        const original = typeof value.__rsp_original === "string" ? value.__rsp_original : value.preview;
        return { target: value as { truncated: { handle: "" } }, original, bytes: Number(value.truncated.bytes ?? 0) };
      }
      stack.push(...Object.values(value));
    }
  }
  return null;
}

function tersePayload(payload: JsonObject): { payload: JsonObject; rowsElided: number } | null {
  for (const key of ["prs", "issues", "runs", "jobs"] as const) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 1) {
      return { payload: { ...payload, [key]: value.slice(0, 1) as JsonValue }, rowsElided: value.length - 1 };
    }
  }
  return null;
}

function stateWord(rows: readonly JsonObject[], preferred: string): string {
  if (rows.every((row) => row.state === preferred)) return preferred;
  return "returned";
}

function countLabel(filtered: number, total: number, query?: string): string {
  return query ? `${filtered}/${total}` : String(filtered);
}

function helpIfQueried(payload: JsonObject, command: GhCommand, help: readonly string[]): JsonObject {
  return command.query ? withHelp(payload, help) : payload;
}

function stateClass(row: Record<string, unknown>): string {
  const state = stringField(row, "state") || stringField(row, "status");
  return state.toLowerCase();
}

function wideCommon(row: Record<string, unknown>): JsonObject {
  return {
    author: authorLogin(row.author),
    labels: labels(row.labels),
    url: stringField(row, "url"),
    updated: stringField(row, "updatedAt"),
  };
}

function addSelected(out: JsonObject, row: Record<string, unknown>, command: GhCommand, fields: readonly string[]): void {
  if (!command.wide && command.fields.size === 0) return;
  for (const field of fields) {
    if (!command.wide && !command.fields.has(field)) continue;
    if (field === "author") out.author = authorLogin(row.author);
    else if (field === "labels") out.labels = labels(row.labels);
    else if (field === "url") out.url = stringField(row, "url");
    else if (field === "updated") out.updated = stringField(row, "updatedAt");
    else if (field === "event") out.event = stringField(row, "event");
    else if (field === "branch") out.branch = stringField(row, "headBranch");
    else if (field === "workflow") out.workflow = stringField(row, "workflowName");
    else if (field === "created") out.created = stringField(row, "createdAt");
  }
}

class GhUsageError extends Error {
  constructor(
    readonly command: GhCommand,
    message: string,
    readonly validFields: readonly string[] = [],
  ) {
    super(message);
  }

  render(): Buffer {
    return renderStructuredError({
      command: `gh ${this.command.kind} ${this.command.action}`,
      category: "usage",
      error: this.message,
      help: `gh ${this.command.kind} ${this.command.action} --help`,
      validFlags: this.validFields,
    });
  }
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => isRecord(item) ? stringField(item, "name") : String(item)).filter(Boolean);
}

function authorLogin(value: unknown): string {
  return isRecord(value) ? stringField(value, "login") : "";
}

function parseJson(raw: string): unknown {
  return raw.trim() ? JSON.parse(raw) : null;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

function numberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
