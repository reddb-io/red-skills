import { spawn } from "node:child_process";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { RspElisionStore, type RspLossLevel } from "./elision-store.js";
import type { RecordedGitContract } from "./git-wrapper.js";

export type GhKind = "pr" | "issue" | "run";
export type GhAction = "list" | "view";

export interface GhRenderOptions {
  level: RspLossLevel;
  store?: RspElisionStore;
}

export interface GhRenderResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  payload?: JsonObject;
  mintedHandle?: `el:${string}`;
  bytesElided?: number;
  rowsElided?: number;
}

interface GhCommand {
  kind: GhKind;
  action: GhAction;
  full: boolean;
  wide: boolean;
  passthrough: string[];
}

const DEFAULT_FIELDS: Record<`${GhKind}:${GhAction}`, string[]> = {
  "pr:list": ["number", "title", "state", "isDraft"],
  "pr:view": ["number", "title", "state", "body"],
  "issue:list": ["number", "title", "state", "labels"],
  "issue:view": ["number", "title", "state", "body"],
  "run:list": ["databaseId", "name", "status", "conclusion"],
  "run:view": ["databaseId", "name", "status", "conclusion", "jobs"],
};

const WIDE_FIELDS: Record<`${GhKind}:${GhAction}`, string[]> = {
  "pr:list": ["number", "title", "state", "isDraft", "author", "labels", "url", "updatedAt"],
  "pr:view": ["number", "title", "state", "body", "author", "labels", "url", "baseRefName", "headRefName"],
  "issue:list": ["number", "title", "state", "labels", "author", "url", "updatedAt"],
  "issue:view": ["number", "title", "state", "body", "author", "labels", "url", "updatedAt"],
  "run:list": ["databaseId", "name", "status", "conclusion", "event", "headBranch", "workflowName", "createdAt"],
  "run:view": ["databaseId", "name", "status", "conclusion", "event", "headBranch", "workflowName", "createdAt", "jobs", "url"],
};

const BODY_LIMIT = 160;
const LOG_LIMIT = 160;

export async function runGhWrapper(argv: readonly string[], options: GhRenderOptions): Promise<GhRenderResult> {
  const command = parseGhCommand(argv);
  const contract = await collectGhContract(command);
  return renderGhContract(argv, contract, options);
}

export async function renderGhContract(
  commandArgv: readonly string[],
  contract: RecordedGitContract,
  options: GhRenderOptions,
): Promise<GhRenderResult> {
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    return {
      stdout: Buffer.from(contract.stdout),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
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

  const marker = `… elided ${terse.rowsElided} rows (+${bytesElided}) — rsp show ${handle}\n`;
  return {
    stdout: Buffer.from(`${encode(terse.payload)}\n${marker}`),
    stderr: Buffer.from(contract.stderr),
    status: contract.status,
    signal: contract.signal,
    payload: terse.payload,
    mintedHandle: handle,
    bytesElided,
    rowsElided: terse.rowsElided,
  };
}

function parseGhCommand(argv: readonly string[]): GhCommand {
  if (argv[0] !== "gh") throw new Error("expected rsp gh <surface> <subcommand>");
  const kind = argv[1];
  const action = argv[2];
  if (!(kind === "pr" || kind === "issue" || kind === "run")) throw new Error(`unsupported gh surface: ${kind ?? ""}`);
  if (!(action === "list" || action === "view")) throw new Error(`unsupported gh subcommand: ${action ?? ""}`);

  const passthrough: string[] = [];
  let full = false;
  let wide = false;
  for (const arg of argv.slice(3)) {
    if (arg === "--full") full = true;
    else if (arg === "--wide") wide = true;
    else passthrough.push(arg);
  }
  return { kind, action, full, wide, passthrough };
}

function machineArgs(command: GhCommand): string[] {
  const key = `${command.kind}:${command.action}` as const;
  const fields = command.wide ? WIDE_FIELDS[key] : DEFAULT_FIELDS[key];
  return [command.kind, command.action, ...command.passthrough, "--json", fields.join(",")];
}

async function collectGhContract(command: GhCommand): Promise<RecordedGitContract> {
  const child = spawn("gh", machineArgs(command), { stdio: ["ignore", "pipe", "pipe"] });
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
  if (command.action === "list" && Array.isArray(parsed) && parsed.length === 0) {
    return emptyState(command.kind);
  }

  const base = { command: commandArgv.join(" ") };
  switch (`${command.kind}:${command.action}`) {
    case "pr:list": {
      const rows = arrayOfRecords(parsed).map((row) => projectPr(row, command.wide));
      return { ...base, prs: rows, summary: `${rows.length} ${stateWord(rows, "open")} PRs` };
    }
    case "pr:view":
      return { ...base, pr: projectPrView(recordOf(parsed), command), summary: `PR #${numberField(recordOf(parsed), "number")}` };
    case "issue:list": {
      const rows = arrayOfRecords(parsed).map((row) => projectIssue(row, command.wide));
      return { ...base, issues: rows, summary: `${rows.length} ${stateWord(rows, "open")} issues` };
    }
    case "issue:view":
      return { ...base, issue: projectIssueView(recordOf(parsed), command), summary: `issue #${numberField(recordOf(parsed), "number")}` };
    case "run:list": {
      const rows = arrayOfRecords(parsed).map((row) => projectRun(row, command.wide));
      return { ...base, runs: rows, summary: `${rows.length} runs` };
    }
    case "run:view":
      return { ...base, run: projectRunView(recordOf(parsed), command), summary: `run ${numberField(recordOf(parsed), "databaseId")}` };
  }
  throw new Error(`unsupported gh command: ${command.kind} ${command.action}`);
}

function emptyState(kind: GhKind): string {
  if (kind === "pr") return "0 open PRs — try: rsp gh issue list\n";
  if (kind === "issue") return "0 open issues — try: rsp gh issue list --state all\n";
  return "0 runs — try: rsp gh run list --limit 20\n";
}

function projectPr(row: Record<string, unknown>, wide: boolean): JsonObject {
  const out: JsonObject = {
    number: numberField(row, "number"),
    title: stringField(row, "title"),
    state: stateClass(row),
    draft: Boolean(row.isDraft),
  };
  if (wide) Object.assign(out, wideCommon(row));
  return out;
}

function projectPrView(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = projectPr(row, command.wide);
  out.body = textField(row, "body", BODY_LIMIT, command.full);
  if (command.wide) {
    out.base = stringField(row, "baseRefName");
    out.head = stringField(row, "headRefName");
  }
  return out;
}

function projectIssue(row: Record<string, unknown>, wide: boolean): JsonObject {
  const out: JsonObject = {
    number: numberField(row, "number"),
    title: stringField(row, "title"),
    state: stateClass(row),
    labels: labels(row.labels),
  };
  if (wide) Object.assign(out, wideCommon(row));
  return out;
}

function projectIssueView(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = projectIssue(row, command.wide);
  out.body = textField(row, "body", BODY_LIMIT, command.full);
  return out;
}

function projectRun(row: Record<string, unknown>, wide: boolean): JsonObject {
  const out: JsonObject = {
    id: numberField(row, "databaseId"),
    name: stringField(row, "name"),
    status: stateClass(row),
    conclusion: stringField(row, "conclusion"),
  };
  if (wide) {
    out.event = stringField(row, "event");
    out.branch = stringField(row, "headBranch");
    out.workflow = stringField(row, "workflowName");
    out.created = stringField(row, "createdAt");
  }
  return out;
}

function projectRunView(row: Record<string, unknown>, command: GhCommand): JsonObject {
  const out: JsonObject = projectRun(row, command.wide);
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

function findHandleRequest(payload: JsonObject): { target: { truncated: { handle: `el:${string}` | "" } }; original: string; bytes: number } | null {
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
