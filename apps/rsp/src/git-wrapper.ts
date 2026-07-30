import { spawn } from "node:child_process";
import { startChildProcessTimer } from "./overhead-budget.js";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD } from "./config.js";
import { type RspMintMeta, type RspLossLevel } from "./elision-store.js";
import { extractLeverArgs, filterRows, withHelp } from "./output-levers.js";
import { classifyWrappedFailure, renderStructuredError, renderUnknownFlag } from "./structured-error.js";

export { DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD } from "./config.js";

export type GitSubcommand = "status" | "log" | "diff" | "commit" | "push" | "blame" | "branch" | "show";

export const GIT_LOG_MACHINE_FIELDS = ["%h", "%an", "%as", "%s"] as const;

export interface RecordedGitContract {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

export interface GitRenderOptions {
  level: RspLossLevel;
  store?: RspMintStore;
  heavyGitByteThreshold?: number;
}

export interface RspMintStore {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
}

export interface GitRenderResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  payload?: JsonObject;
  mintedHandle?: string;
  bytesElided?: number;
  rowsElided?: number;
  oneLine?: boolean;
  rawOutput?: Buffer;
  degradation?: {
    reason: string;
    family: string;
    stderrHead: string;
  };
}

export async function runGitWrapper(argv: readonly string[], options: GitRenderOptions): Promise<GitRenderResult> {
  const parsed = parseGitRenderCommand(argv);
  const subcommand = parseGitSubcommand(parsed.argv);
  const contract = await collectGitContract(subcommand, parsed.argv.slice(1));
  return renderGitContract(argv, contract, options);
}

export async function renderGitContract(
  command: readonly string[],
  contract: RecordedGitContract,
  options: GitRenderOptions,
): Promise<GitRenderResult> {
  const parsedCommand = parseGitRenderCommand(command);
  if ((contract.status ?? 0) !== 0 || contract.signal) {
    const error = classifyWrappedFailure(command.join(" "), contract.stdout, contract.stderr);
    return {
      stdout: renderStructuredError(error),
      stderr: Buffer.from(contract.stderr),
      status: error.exitCode ?? 1,
      signal: contract.signal,
    };
  }

  const subcommand = parseGitSubcommand(parsedCommand.argv);
  let payload: JsonObject;
  try {
    payload = parseGitPayload(subcommand, parsedCommand.argv, contract.stdout, parsedCommand.query);
  } catch (err) {
    if (err instanceof GitStatusPassthroughError) {
      return {
        stdout: Buffer.from(contract.stdout),
        stderr: Buffer.from(contract.stderr),
        status: contract.status,
        signal: contract.signal,
        rawOutput: Buffer.from(contract.stdout),
        degradation: {
          reason: err.reason,
          family: "git status",
          stderrHead: err.message,
        },
      };
    }
    throw err;
  }

  const fullToon = encode(payload);
  if (shouldEmitFull(subcommand, fullToon, parsedCommand.full, options)) {
    return {
      stdout: Buffer.from(fullToon),
      stderr: Buffer.from(contract.stderr),
      status: contract.status,
      signal: contract.signal,
      payload,
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
    };
  }

  const bytesElided = Buffer.byteLength(fullToon);
  const handle = await options.store?.mint(Buffer.from(fullToon), {
    command: command.join(" "),
    loss: { level: "terse", bytes_elided: bytesElided },
  });
  if (!handle) throw new Error("terse git output requires an elision store");

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

export function recoveryInstruction(handle: string): string {
  return handle.startsWith("el:") ? `rsp show ${handle}` : handle;
}

interface ParsedGitRenderCommand {
  argv: string[];
  query?: string;
  full: boolean;
}

function parseGitRenderCommand(command: readonly string[]): ParsedGitRenderCommand {
  const { argv, query, full } = extractLeverArgs(command);
  const unknown = argv.slice(2).find((arg) => arg.startsWith("--rsp-"));
  if (unknown) throw new StructuredUsageError(command.join(" "), unknown, ["--full", "--brief", "--terse", "--query"]);
  return { argv, query, full };
}

function shouldEmitFull(
  subcommand: GitSubcommand,
  fullToon: string,
  fullRequested: boolean,
  options: GitRenderOptions,
): boolean {
  if (options.level === "terse") return false;
  if (fullRequested || options.level === "full") return true;
  if (!isHeavyGitSubcommand(subcommand)) return true;
  if (options.level !== "lossless") return true;

  const threshold = positiveNumber(options.heavyGitByteThreshold, DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD);
  return Buffer.byteLength(fullToon) <= threshold;
}

function isHeavyGitSubcommand(subcommand: GitSubcommand): boolean {
  return subcommand === "diff" || subcommand === "log" || subcommand === "blame" || subcommand === "show";
}

function parseGitSubcommand(argv: readonly string[]): GitSubcommand {
  if (argv[0] !== "git") throw new Error("expected rsp git <subcommand>");
  const subcommand = argv[1];
  if (
    subcommand === "status" ||
    subcommand === "log" ||
    subcommand === "diff" ||
    subcommand === "commit" ||
    subcommand === "push" ||
    subcommand === "blame" ||
    subcommand === "branch" ||
    subcommand === "show"
  ) {
    return subcommand;
  }
  throw new Error(`unsupported git subcommand: ${subcommand ?? ""}`);
}

function machineArgs(subcommand: GitSubcommand, rest: readonly string[]): string[] {
  const passthrough = rest.slice(1);
  switch (subcommand) {
    case "status":
      return ["status", "--porcelain=v2", "-z", "-b", ...passthrough];
    case "log":
      return ["log", `--format=%x1e${GIT_LOG_MACHINE_FIELDS.join("%x1f")}`, "-z", ...passthrough];
    case "diff":
      return ["diff", "--numstat", "-z", ...passthrough];
    case "commit":
      return ["commit", ...passthrough];
    case "push":
      return ["push", "--porcelain", ...passthrough];
    case "blame":
      return ["blame", "--line-porcelain", ...passthrough];
    case "branch":
      return [
        "branch",
        "--format=%(HEAD)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(worktreepath)%00%(contents:subject)",
        ...passthrough,
      ];
    case "show":
      return ["show", "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e", "--stat", ...passthrough];
  }
}

async function collectGitContract(subcommand: GitSubcommand, rest: readonly string[]): Promise<RecordedGitContract> {
  const child = spawn("git", machineArgs(subcommand, rest), { stdio: ["ignore", "pipe", "pipe"] });
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

function parseGitPayload(subcommand: GitSubcommand, command: readonly string[], stdout: string, query?: string): JsonObject {
  switch (subcommand) {
    case "status":
      return parseStatus(command, stdout, query);
    case "log":
      return parseLog(command, stdout, query);
    case "diff":
      return parseDiff(command, stdout, query);
    case "commit":
      return helpIfQueried(parseCommit(command, stdout), query, ["rsp git status --query <path-or-state>"]);
    case "push":
      return helpIfQueried(parsePush(command, stdout), query, ["rsp gh pr list --query <branch>"]);
    case "blame":
      return parseBlame(command, stdout, query);
    case "branch":
      return parseBranch(command, stdout, query);
    case "show":
      return parseShow(command, stdout, query);
  }
}

function parseStatus(command: readonly string[], stdout: string, query?: string): JsonObject {
  let branch = "";
  const rows: JsonObject[] = [];
  let recognized = false;
  let sawContent = false;
  for (const raw of statusRecords(stdout)) {
    if (!raw) continue;
    sawContent = true;
    if (raw.startsWith("# branch.head ")) {
      branch = raw.slice("# branch.head ".length);
      recognized = true;
      continue;
    }
    if (raw.startsWith("# ")) {
      recognized = true;
      continue;
    }
    if (raw.startsWith("## ")) {
      branch = shortStatusBranch(raw);
      recognized = true;
      continue;
    }
    const v2 = parsePorcelainV2StatusRow(raw);
    if (v2) {
      recognized = true;
      rows.push(v2);
      continue;
    }
    const short = parseShortStatusRow(raw);
    if (short) {
      recognized = true;
      rows.push(short);
    }
  }
  if (rows.length === 0) {
    if (!sawContent || recognized) return cleanStatusPayload(command.join(" "), branch);
    throw new GitStatusPassthroughError("git-status-unparseable");
  }
  const filteredRows = filterRows(rows, query);
  const counts = countBy(filteredRows, "state");
  return helpIfQueried({
    command: command.join(" "),
    branch,
    rows: filteredRows as JsonValue,
    summary: statusSummary(filteredRows.length, rows.length, counts, query),
  }, query, ["rsp git diff --query <path>", "rsp git log --query <subject>"]);
}

function statusRecords(stdout: string): string[] {
  return stdout.includes("\0") ? stdout.split("\0") : stdout.split(/\r?\n/);
}

function parsePorcelainV2StatusRow(raw: string): JsonObject | null {
  if (raw.startsWith("1 ")) {
    const parts = raw.split(" ");
    const xy = parts[1] ?? "..";
    const path = parts.slice(8).join(" ");
    return statusRow(path, xy);
  }
  if (raw.startsWith("2 ")) {
    const parts = raw.split(" ");
    const xy = parts[1] ?? "..";
    return statusRow(parts.slice(9).join(" "), xy);
  }
  if (raw.startsWith("u ")) {
    const parts = raw.split(" ");
    const xy = parts[1] ?? "..";
    return statusRow(parts.slice(10).join(" "), xy);
  }
  if (raw.startsWith("? ")) return statusRow(raw.slice(2), "??");
  return null;
}

function parseShortStatusRow(raw: string): JsonObject | null {
  if (raw.length < 4 || raw[2] !== " ") return null;
  const xy = raw.slice(0, 2);
  if (!/^[ MADRCU?!][ MADRCU?!?]$/.test(xy)) return null;
  return statusRow(shortStatusPath(raw.slice(3), xy), xy);
}

function statusRow(path: string, xy: string): JsonObject {
  const index = normalizeStatusCode(xy[0] ?? ".");
  const worktree = normalizeStatusCode(xy[1] ?? ".");
  return {
    path: decodeGitQuotedPath(path),
    index,
    worktree,
    state: statusState(`${index}${worktree}`),
  };
}

function normalizeStatusCode(code: string): string {
  return code === " " ? "." : code;
}

function shortStatusBranch(raw: string): string {
  const branch = raw.slice(3).split("...")[0]?.trim() ?? "";
  return branch === "HEAD (no branch)" ? "HEAD" : branch;
}

function shortStatusPath(rawPath: string, xy: string): string {
  if (!xy.includes("R") && !xy.includes("C")) return rawPath;
  const arrow = rawPath.lastIndexOf(" -> ");
  return arrow >= 0 ? rawPath.slice(arrow + " -> ".length) : rawPath;
}

function decodeGitQuotedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function statusSummary(
  filtered: number,
  total: number,
  counts: Record<string, number>,
  query: string | undefined,
): string {
  const extras: string[] = [];
  if (counts.renamed) extras.push(`${counts.renamed} renamed`);
  if (counts.untracked) extras.push(`${counts.untracked} untracked`);
  if (counts.changed) extras.push(`${counts.changed} changed`);
  return `${query ? `${filtered}/${total}` : filtered} changes: ${counts.added ?? 0} added, ${counts.modified ?? 0} modified, ${counts.deleted ?? 0} deleted${extras.length ? `, ${extras.join(", ")}` : ""}`;
}

export function cleanStatusPayload(command = "git status", branch = ""): JsonObject {
  return {
    command,
    category: "no-op",
    exit_code: 0,
    noop: true,
    scope: "git status",
    empty: true,
    branch,
    rows: [],
    summary: "git status clean: 0 changes",
  };
}

function parseLog(command: readonly string[], stdout: string, query?: string): JsonObject {
  const commits = stdout.split("\0").filter(Boolean).map((record) => {
    const fields = record.replace(/^\x1e/, "").split("\x1f");
    return {
      short: fields[0] ?? "",
      author: fields[1] ?? "",
      date: fields[2] ?? "",
      subject: fields[3] ?? "",
    };
  });
  const filteredCommits = filterRows(commits, query);
  return helpIfQueried({
    command: command.join(" "),
    commits: filteredCommits as JsonValue,
    summary: `${query ? `${filteredCommits.length}/${commits.length}` : filteredCommits.length} commits`,
  }, query, ["rsp git diff --query <path>", "rsp gh pr list --query <branch>"]);
}

function parseDiff(command: readonly string[], stdout: string, query?: string): JsonObject {
  const fields = stdout.split("\0").filter(Boolean);
  const files = fields.map((entry) => {
    const [added, deleted, path] = entry.split("\t");
    return {
      path: path ?? "",
      added: added === "-" ? null : Number(added ?? 0),
      deleted: deleted === "-" ? null : Number(deleted ?? 0),
    };
  });
  const filteredFiles = filterRows(files, query);
  const totals = filteredFiles.reduce((acc, file) => {
    acc.added += typeof file.added === "number" ? file.added : 0;
    acc.deleted += typeof file.deleted === "number" ? file.deleted : 0;
    return acc;
  }, { added: 0, deleted: 0 });
  return helpIfQueried({
    command: command.join(" "),
    files: filteredFiles as JsonValue,
    summary: `${query ? `${filteredFiles.length}/${files.length}` : filteredFiles.length} files, +${totals.added} -${totals.deleted}`,
  }, query, ["rsp git status --query <path>", "rsp git log --query <subject>"]);
}

function parseCommit(command: readonly string[], stdout: string): JsonObject {
  const first = stdout.split("\n")[0] ?? "";
  const match = /^\[([^ ]+) ([0-9a-f]+)\] (.+)$/.exec(first);
  const changed = /(\d+) files? changed/.exec(stdout);
  const insertions = /(\d+) insertions?\(\+\)/.exec(stdout);
  const deletions = /(\d+) deletions?\(-\)/.exec(stdout);
  const branch = match?.[1] ?? "";
  const commit = match?.[2] ?? "";
  const filesChanged = Number(changed?.[1] ?? 0);
  const added = Number(insertions?.[1] ?? 0);
  const deleted = Number(deletions?.[1] ?? 0);
  return {
    command: command.join(" "),
    branch,
    commit,
    subject: match?.[3] ?? "",
    files_changed: filesChanged,
    insertions: added,
    deletions: deleted,
    summary: `commit ${commit} on ${branch}: ${filesChanged} files, +${added} -${deleted}`,
  };
}

function parsePush(command: readonly string[], stdout: string): JsonObject {
  const lines = stdout.split("\n").filter(Boolean);
  const remote = lines.find((line) => line.startsWith("To "))?.slice(3) ?? "";
  const refs = lines.filter((line) => line.includes("\t")).map((line) => {
    const [flag, refspec, summary = ""] = line.split("\t");
    const [from, to] = (refspec ?? "").split(":");
    return { flag: flag ?? "", from: from ?? "", to: to ?? "", summary };
  });
  const pushed = refs.find((ref) => ref.flag !== "=") ?? refs[0];
  const branch = pushed?.to.startsWith("refs/heads/") ? pushed.to.slice("refs/heads/".length) : (pushed?.to ?? "");
  const commitCount = pushed?.summary.includes("..") ? 1 : 0;
  if (refs.length > 0 && refs.every((ref) => ref.flag === "=")) {
    return {
      command: command.join(" "),
      category: "no-op",
      exit_code: 0,
      noop: true,
      remote,
      refs,
      summary: `push already satisfied for ${branch} -> ${remote}`,
      help: ["rsp gh pr list --query <branch>"] as JsonValue,
    };
  }
  return {
    command: command.join(" "),
    remote,
    refs,
    summary: `pushed ${branch} -> ${remote} +${commitCount} commits`,
  };
}

export class StructuredUsageError extends Error {
  constructor(
    readonly command: string,
    readonly flag: string,
    readonly validFlags: readonly string[],
  ) {
    super(`unknown flag: ${flag}`);
  }

  render(): Buffer {
    return renderUnknownFlag(this.command, this.flag, this.validFlags, `${this.command} --help`);
  }
}

class GitStatusPassthroughError extends Error {
  constructor(readonly reason: string) {
    super("git status output was not recognized; passing raw stdout through");
  }
}

function parseBlame(command: readonly string[], stdout: string, query?: string): JsonObject {
  const lines = stdout.split("\n");
  const attributions: Array<{ line_start: number; line_end: number; author: string; commit: string; path: string }> = [];
  let cursor: { commit: string; finalLine: number; author: string; path: string } | null = null;
  for (const line of lines) {
    const header = /^([0-9a-f]{8,40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      cursor = { commit: header[1] ?? "", finalLine: Number(header[2] ?? 0), author: "", path: "" };
      continue;
    }
    if (!cursor) continue;
    if (line.startsWith("author ")) {
      cursor.author = line.slice("author ".length);
      continue;
    }
    if (line.startsWith("filename ")) {
      cursor.path = line.slice("filename ".length);
      continue;
    }
    if (!line.startsWith("\t")) continue;
    const previous = attributions.at(-1);
    const shortCommit = cursor.commit.slice(0, 12);
    if (
      previous &&
      previous.commit === shortCommit &&
      previous.author === cursor.author &&
      previous.path === cursor.path &&
      previous.line_end + 1 === cursor.finalLine
    ) {
      previous.line_end = cursor.finalLine;
    } else {
      attributions.push({
        line_start: cursor.finalLine,
        line_end: cursor.finalLine,
        author: cursor.author,
        commit: shortCommit,
        path: cursor.path,
      });
    }
    cursor = null;
  }
  const filteredAttributions = filterRows(attributions, query);
  const authorCounts = countBy(filteredAttributions, "author");
  return helpIfQueried({
    command: command.join(" "),
    ranges: filteredAttributions as JsonValue,
    authors: authorCounts,
    summary: `${query ? `${filteredAttributions.length}/${attributions.length}` : filteredAttributions.length} ranges, ${Object.keys(authorCounts).length} authors`,
  }, query, ["rsp git show --query <commit>", "rsp git log --query <author>"]);
}

function parseBranch(command: readonly string[], stdout: string, query?: string): JsonObject {
  const branches = stdout.split("\n").filter(Boolean).map((record) => {
    const [head, name, commit, upstream, worktree, subject] = record.split("\0");
    return {
      current: head === "*",
      name: name ?? "",
      commit: commit ?? "",
      upstream: upstream || null,
      worktree: worktree || null,
      subject: subject ?? "",
    };
  });
  const filteredBranches = filterRows(branches, query);
  const current = filteredBranches.find((branch) => branch.current)?.name ?? "";
  return helpIfQueried({
    command: command.join(" "),
    branches: filteredBranches as JsonValue,
    summary: `${query ? `${filteredBranches.length}/${branches.length}` : filteredBranches.length} branches${current ? `, current ${current}` : ""}`,
  }, query, ["rsp git log --query <branch>", "rsp gh pr list --query <branch>"]);
}

function parseShow(command: readonly string[], stdout: string, query?: string): JsonObject {
  const start = stdout.indexOf("\x1e");
  const end = start >= 0 ? stdout.indexOf("\x1e", start + 1) : -1;
  const metaRaw = start >= 0 && end >= 0 ? stdout.slice(start + 1, end) : "";
  const statRaw = end >= 0 ? stdout.slice(end + 1) : stdout;
  const [commit, short, author, date, subject, body = ""] = metaRaw.split("\x1f");
  const files: JsonObject[] = [];
  for (const line of statRaw.split("\n")) {
    const match = /^\s*(.+?)\s+\|\s+(\d+)\s+([+\-]+|Bin.*)$/.exec(line);
    if (!match) continue;
    const graph = match[3] ?? "";
    files.push({
      path: (match[1] ?? "").trim(),
      changed: Number(match[2] ?? 0),
      added: [...graph].filter((char) => char === "+").length,
      deleted: [...graph].filter((char) => char === "-").length,
      binary: graph.startsWith("Bin"),
    });
  }
  const filteredFiles = filterRows(files, query);
  let changed = 0;
  let added = 0;
  let deleted = 0;
  for (const file of filteredFiles) {
    changed += typeof file.changed === "number" ? file.changed : 0;
    added += typeof file.added === "number" ? file.added : 0;
    deleted += typeof file.deleted === "number" ? file.deleted : 0;
  }
  return helpIfQueried({
    command: command.join(" "),
    commit: commit ?? "",
    short: short ?? "",
    author: author ?? "",
    date: date ?? "",
    subject: subject ?? "",
    body_lines: body.trim() ? body.trim().split("\n").length : 0,
    files: filteredFiles as JsonValue,
    summary: `${query ? `${filteredFiles.length}/${files.length}` : filteredFiles.length} files, ${changed} changed, +${added} -${deleted}`,
  }, query, ["rsp git blame --query <author-or-path>", "rsp git diff --query <path>"]);
}

function helpIfQueried(payload: JsonObject, query: string | undefined, help: readonly string[]): JsonObject {
  return query ? withHelp(payload, help) : payload;
}


function statusState(xy: string): string {
  if (xy === "??") return "untracked";
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("M")) return "modified";
  return "changed";
}

function countBy(rows: readonly JsonObject[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? "");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function tersePayload(payload: JsonObject): { payload: JsonObject; rowsElided: number } | null {
  for (const key of ["rows", "commits", "files", "refs", "ranges", "branches"] as const) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 1) {
      return {
        payload: { ...payload, [key]: value.slice(0, 1) as JsonValue },
        rowsElided: value.length - 1,
      };
    }
  }
  return null;
}
