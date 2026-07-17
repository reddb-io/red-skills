import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { decode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import { readGhConditionalJson } from "./gh-conditional.js";

type WaitKind = "cmd" | "pr" | "run" | "release";
type WaitStatus = "running" | "success" | "failure" | "timeout" | "indeterminate";

interface WaitOptions {
  timeoutMs: number;
  reason: string;
  signalPid?: number;
  signal: NodeJS.Signals;
  notifyCmd?: string;
}

interface WaitRegistryEntry {
  id: string;
  target: string;
  reason: string;
  pid: number;
  started_at: string;
  poll_tier: string;
  status: WaitStatus;
}

interface Verdict {
  status: WaitStatus;
  exitCode: 0 | 1 | 2;
  summary: string;
  details?: JsonObject;
}

interface ParsedWait {
  kind?: WaitKind | "ls" | "help";
  target?: string;
  branch?: string;
  latest?: boolean;
  tagGlob?: string;
  commandLine?: string;
  options: WaitOptions;
}

const DEFAULT_TIMEOUT_MS: Record<WaitKind, number> = {
  cmd: 30 * 60_000,
  pr: 60 * 60_000,
  run: 60 * 60_000,
  release: 2 * 60 * 60_000,
};

const POLL_TIERS: Record<WaitKind, string> = {
  cmd: "local-cmd:2-5s",
  pr: "github-pr:15-20s-backoff-jitter",
  run: "github-run:15-20s-backoff-jitter",
  release: "release:60s",
};

export async function runWait(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseWaitArgs(argv);
  if (parsed.kind === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(renderWaitHelp());
    return 0;
  }
  if (parsed.kind === "ls") {
    process.stdout.write(`${encodeSnapshotToon({ waits: await listWaits(cwd) })}\n`);
    return 0;
  }
  if (!isWaitKind(parsed.kind)) {
    process.stdout.write(renderWaitHelp());
    return 2;
  }
  const waitKind = parsed.kind;

  const entry: WaitRegistryEntry = {
    id: randomUUID(),
    target: waitTarget(parsed),
    reason: parsed.options.reason,
    pid: process.pid,
    started_at: new Date().toISOString(),
    poll_tier: POLL_TIERS[parsed.kind],
    status: "running",
  };
  const registryPath = join(await waitRegistryDir(cwd), `${entry.id}.json`);

  let verdict: Verdict = { status: "indeterminate", exitCode: 2, summary: "wait did not start" };
  try {
    await mkdir(await waitRegistryDir(cwd), { recursive: true });
    await writeRegistryEntry(registryPath, entry);
    verdict = await dispatchWait({ ...parsed, kind: waitKind }, cwd, registryPath, entry);
    process.stdout.write(`${encodeSnapshotToon(renderVerdict(waitKind, entry, verdict))}\n`);
    await signalCompletion(parsed.options);
    return verdict.exitCode;
  } finally {
    await rm(registryPath, { force: true });
  }
}

function isWaitKind(kind: ParsedWait["kind"]): kind is WaitKind {
  return kind === "cmd" || kind === "pr" || kind === "run" || kind === "release";
}

export function renderWaitHelp(): string {
  return [
    "usage: rsp wait <subcommand> [options]",
    "",
    "Subcommands:",
    "  rsp wait pr <number> [--timeout 45m] [--reason <text>]",
    "  rsp wait run <id|--branch <branch> --latest> [--timeout 45m]",
    "  rsp wait release [--tag <glob>] [--timeout 2h]",
    "  rsp wait cmd -- \"<command line>\" [--timeout 30m]",
    "  rsp wait ls",
    "",
    "Examples:",
    "  rsp wait pr 123 --reason \"before merge\"",
    "  rsp wait run --branch feature/wait --latest",
    "  rsp wait release --tag \"v2.*\"",
    "  rsp wait cmd -- \"pnpm -C apps/rsp build\"",
    "  rsp wait ls",
    "",
    "Doctrine: never hand-write sleep polling loops; run rsp wait in a background shell - process exit IS the signal.",
    "Exit codes: 0 = success verdict, 1 = failure verdict, 2 = timeout/indeterminate.",
    "Completion hooks: --signal-pid <pid> [--signal USR1] and --notify-cmd \"<cmd>\" run after a verdict.",
    "",
  ].join("\n");
}

function parseWaitArgs(argv: readonly string[]): ParsedWait {
  const kind = argv[1];
  const options: WaitOptions = {
    timeoutMs: DEFAULT_TIMEOUT_MS.cmd,
    reason: "",
    signal: "SIGUSR1",
  };
  const parsed: ParsedWait = { kind: kind as ParsedWait["kind"], options };
  if (!kind || kind === "--help" || kind === "-h") return { ...parsed, kind: "help" };
  if (kind === "ls") return parsed;
  if (kind !== "cmd" && kind !== "pr" && kind !== "run" && kind !== "release") return { ...parsed, kind: undefined };

  options.timeoutMs = DEFAULT_TIMEOUT_MS[kind];
  const commandSeparator = argv.indexOf("--");
  const optionEnd = commandSeparator >= 0 ? commandSeparator : argv.length;
  for (let i = 2; i < optionEnd; i++) {
    const value = argv[i];
    if (value === "--timeout") options.timeoutMs = parseDuration(argv[++i] ?? "");
    else if (value === "--reason") options.reason = argv[++i] ?? "";
    else if (value === "--signal-pid") options.signalPid = Number(argv[++i]);
    else if (value === "--signal") options.signal = normalizeSignal(argv[++i] ?? "");
    else if (value === "--notify-cmd") options.notifyCmd = argv[++i] ?? "";
    else if (kind === "run" && value === "--branch") parsed.branch = argv[++i] ?? "";
    else if (kind === "run" && value === "--latest") parsed.latest = true;
    else if (kind === "release" && value === "--tag") parsed.tagGlob = argv[++i] ?? "";
    else if (!value.startsWith("--") && !parsed.target) parsed.target = value;
  }
  if (kind === "cmd") parsed.commandLine = commandSeparator >= 0 ? argv.slice(commandSeparator + 1).join(" ") : "";
  return parsed;
}

async function dispatchWait(
  parsed: ParsedWait & { kind: WaitKind },
  cwd: string,
  registryPath: string,
  entry: WaitRegistryEntry,
): Promise<Verdict> {
  switch (parsed.kind) {
    case "cmd":
      return await waitCmd(parsed.commandLine ?? "", parsed.options.timeoutMs, cwd, registryPath, entry);
    case "pr":
      return await pollUntilDone(
        createPrProbe(parsed.target ?? "", cwd, {
          emptyChecksGraceMs: envDuration("RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS", 30_000),
        }),
        parsed.options.timeoutMs,
        envDuration("RSP_WAIT_PR_POLL_MS", 15_000),
        registryPath,
        entry,
      );
    case "run":
      return await pollUntilDone(() => probeRun(parsed, cwd), parsed.options.timeoutMs, 15_000, registryPath, entry);
    case "release":
      return await pollUntilDone(
        () => probeRelease(parsed.tagGlob, new Date(entry.started_at), cwd),
        parsed.options.timeoutMs,
        60_000,
        registryPath,
        entry,
      );
  }
}

async function waitCmd(commandLine: string, timeoutMs: number, cwd: string, registryPath: string, entry: WaitRegistryEntry): Promise<Verdict> {
  if (!commandLine.trim()) return { status: "indeterminate", exitCode: 2, summary: "missing command line" };
  return await new Promise((resolveVerdict) => {
    let settled = false;
    const finish = (verdictValue: Verdict) => {
      if (settled) return;
      settled = true;
      resolveVerdict(verdictValue);
    };
    const child = spawn(commandLine, { cwd, shell: true, stdio: "ignore", detached: false });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      void writeStatus(registryPath, entry, "timeout");
      finish({ status: "timeout", exitCode: 2, summary: `command timed out after ${formatDuration(timeoutMs)}` });
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timeout);
      void writeStatus(registryPath, entry, "failure");
      finish({ status: "failure", exitCode: 1, summary: err.message });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      const ok = status === 0;
      void writeStatus(registryPath, entry, ok ? "success" : "failure");
      finish({
        status: ok ? "success" : "failure",
        exitCode: ok ? 0 : 1,
        summary: ok ? "command exited successfully" : `command exited with ${signal ?? status ?? "unknown"}`,
        details: { status: status ?? null, signal: signal ?? null },
      });
    });
  });
}

async function pollUntilDone(
  probe: () => Promise<Verdict>,
  timeoutMs: number,
  baseSleepMs: number,
  registryPath: string,
  entry: WaitRegistryEntry,
): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const verdict = await probe();
    if (verdict.status !== "running" && verdict.status !== "indeterminate") {
      await writeStatus(registryPath, entry, verdict.status);
      return verdict;
    }
    const sleepMs = Math.min(baseSleepMs * 4, Math.round(baseSleepMs * Math.pow(1.25, attempt++))) + Math.floor(Math.random() * 1_000);
    await sleep(Math.min(sleepMs, Math.max(0, deadline - Date.now())));
  }
  await writeStatus(registryPath, entry, "timeout");
  return { status: "timeout", exitCode: 2, summary: `timed out after ${formatDuration(timeoutMs)}` };
}

function createPrProbe(number: string, cwd: string, options: { emptyChecksGraceMs: number }): () => Promise<Verdict> {
  const startedAt = Date.now();
  return () => probePr(number, cwd, options, startedAt);
}

async function probePr(number: string, cwd: string, options: { emptyChecksGraceMs: number }, startedAt: number): Promise<Verdict> {
  if (!/^[1-9][0-9]*$/.test(number)) return { status: "indeterminate", exitCode: 2, summary: "missing PR number" };
  const result = await ghJson(["pr", "view", number, "--json", "number,state,mergeable,statusCheckRollup,url"], cwd);
  if (result.status !== 0) return { status: "indeterminate", exitCode: 2, summary: result.stderr || "gh pr view failed" };
  const row = parseRecord(result.stdout);
  const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : [];
  const mergeable = String(row.mergeable ?? "");
  const states = checks.map(checkState);
  const failing = states.filter((state) => state === "failure").length;
  const pending = states.filter((state) => state === "pending").length;
  if (String(row.state) !== "OPEN") {
    return verdict("failure", `PR #${number} is ${String(row.state).toLowerCase()}`, { mergeable });
  }
  if (failing > 0) return verdict("failure", `PR #${number} has failing checks`, { failing, pending, mergeable });
  if (pending > 0) return { status: "running", exitCode: 2, summary: `PR #${number} has ${pending} pending checks` };
  if (checks.length === 0) {
    const elapsedMs = Date.now() - startedAt;
    if (mergeable === "UNKNOWN" || elapsedMs < options.emptyChecksGraceMs) {
      return {
        status: "running",
        exitCode: 2,
        summary: `PR #${number} has no registered checks yet`,
        details: { checks: 0, mergeable, empty_checks_elapsed_ms: elapsedMs },
      };
    }
    return verdict("success", `PR #${number} has no checks configured`, { checks: 0, mergeable });
  }
  if (mergeable === "UNKNOWN") {
    return {
      status: "running",
      exitCode: 2,
      summary: `PR #${number} mergeability is still unknown`,
      details: { checks: checks.length, mergeable },
    };
  }
  return verdict("success", `PR #${number} checks passed`, { checks: checks.length, mergeable });
}

async function probeRun(parsed: ParsedWait, cwd: string): Promise<Verdict> {
  const id = parsed.target ?? (parsed.latest && parsed.branch ? await latestRunId(parsed.branch, cwd) : "");
  if (!id) return { status: "indeterminate", exitCode: 2, summary: "missing run id" };
  const result = await ghJson(["run", "view", id, "--json", "databaseId,status,conclusion,workflowName,headBranch,url"], cwd);
  if (result.status !== 0) return { status: "indeterminate", exitCode: 2, summary: result.stderr || "gh run view failed" };
  const row = parseRecord(result.stdout);
  const status = String(row.status ?? "").toLowerCase();
  const conclusion = String(row.conclusion ?? "").toLowerCase();
  if (status !== "completed") return { status: "running", exitCode: 2, summary: `run ${id} is ${status || "pending"}` };
  if (conclusion === "success") return verdict("success", `run ${id} succeeded`, runDetails(row));
  return verdict("failure", `run ${id} concluded ${conclusion || "unknown"}`, runDetails(row));
}

async function latestRunId(branch: string, cwd: string): Promise<string> {
  const result = await ghJson(["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId"], cwd);
  if (result.status !== 0) return "";
  const rows = JSON.parse(result.stdout) as unknown;
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return isRecord(first) && first.databaseId != null ? String(first.databaseId) : "";
}

async function probeRelease(tagGlob: string | undefined, startedAt: Date, cwd: string): Promise<Verdict> {
  const result = await ghJson(["release", "list", "--limit", "20", "--json", "tagName,publishedAt,isDraft"], cwd);
  if (result.status !== 0) return { status: "indeterminate", exitCode: 2, summary: result.stderr || "gh release list failed" };
  const rows = JSON.parse(result.stdout) as unknown;
  const releases = Array.isArray(rows) ? rows.filter(isRecord) : [];
  const match = releases.find((release) => {
    const tag = String(release.tagName ?? "");
    const publishedAt = new Date(String(release.publishedAt ?? ""));
    return release.isDraft !== true && (!tagGlob || globMatches(tagGlob, tag)) && publishedAt >= startedAt;
  });
  if (!match) return { status: "running", exitCode: 2, summary: "no matching release is published yet" };
  return verdict("success", `release ${String(match.tagName)} published`, {
    tag: String(match.tagName),
    published_at: String(match.publishedAt ?? ""),
  });
}

async function ghJson(args: readonly string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const conditional = await conditionalGhJson(args, cwd);
  if (conditional) return conditional;
  return await new Promise((resolveResult) => {
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (err) => resolveResult({ status: 1, stdout: "", stderr: err.message }));
    child.once("close", (status) => {
      resolveResult({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

async function conditionalGhJson(args: readonly string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string } | null> {
  if (args[0] === "pr" && args[1] === "view" && args[2]) {
    return await conditionalPrView(args[2], cwd);
  }
  if (args[0] === "run" && args[1] === "view" && args[2]) {
    const response = await readGhConditionalJson({
      path: `repos/{owner}/{repo}/actions/runs/${args[2]}`,
      cwd,
      command: `gh ${args.join(" ")}`,
    });
    if (response.status !== 0) return response;
    const row = recordOf(JSON.parse(response.stdout));
    return {
      status: 0,
      stderr: response.stderr,
      stdout: JSON.stringify({
        databaseId: numberField(row, "database_id") || numberField(row, "id"),
        status: stringField(row, "status").toUpperCase(),
        conclusion: stringField(row, "conclusion").toUpperCase(),
        workflowName: stringField(row, "workflow_name") || stringField(row, "name"),
        headBranch: stringField(row, "head_branch"),
        url: stringField(row, "html_url"),
      }),
    };
  }
  if (args[0] === "run" && args[1] === "list") {
    const branch = optionAfter(args, "--branch");
    const limit = optionAfter(args, "--limit") ?? "20";
    const response = await readGhConditionalJson({
      path: "repos/{owner}/{repo}/actions/runs",
      params: { branch, per_page: limit },
      cwd,
      command: `gh ${args.join(" ")}`,
    });
    if (response.status !== 0) return response;
    const rows = arrayOfRecords(recordOf(JSON.parse(response.stdout)).workflow_runs).map((row) => ({
      databaseId: numberField(row, "database_id") || numberField(row, "id"),
    }));
    return { status: 0, stdout: JSON.stringify(rows), stderr: response.stderr };
  }
  if (args[0] === "release" && args[1] === "list") {
    const limit = optionAfter(args, "--limit") ?? "20";
    const response = await readGhConditionalJson({
      path: "repos/{owner}/{repo}/releases",
      params: { per_page: limit },
      cwd,
      command: `gh ${args.join(" ")}`,
    });
    if (response.status !== 0) return response;
    const rows = arrayOfRecords(JSON.parse(response.stdout)).map((row) => ({
      tagName: stringField(row, "tag_name"),
      publishedAt: stringField(row, "published_at"),
      isDraft: row.draft === true,
    }));
    return { status: 0, stdout: JSON.stringify(rows), stderr: response.stderr };
  }
  return null;
}

async function conditionalPrView(number: string, cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const pr = await readGhConditionalJson({
    path: `repos/{owner}/{repo}/pulls/${number}`,
    cwd,
    command: `gh pr view ${number}`,
  });
  if (pr.status !== 0) return pr;
  const row = recordOf(JSON.parse(pr.stdout));
  if (Array.isArray(row.statusCheckRollup)) return { status: 0, stdout: pr.stdout, stderr: pr.stderr };
  const sha = stringField(recordOf(row.head), "sha");
  const [combinedStatus, checkRuns] = sha
    ? await Promise.all([
      readGhConditionalJson({
        path: `repos/{owner}/{repo}/commits/${sha}/status`,
        cwd,
        command: `gh pr view ${number} status`,
      }),
      readGhConditionalJson({
        path: `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        cwd,
        command: `gh pr view ${number} check-runs`,
      }),
    ])
    : [{ status: 0, stdout: "{}", stderr: "", quotaFree: false }, { status: 0, stdout: "{}", stderr: "", quotaFree: false }];
  const statuses = combinedStatus.status === 0 ? arrayOfRecords(recordOf(JSON.parse(combinedStatus.stdout)).statuses) : [];
  const runs = checkRuns.status === 0 ? arrayOfRecords(recordOf(JSON.parse(checkRuns.stdout)).check_runs) : [];
  return {
    status: 0,
    stderr: [pr.stderr, combinedStatus.stderr, checkRuns.stderr].filter(Boolean).join("\n"),
    stdout: JSON.stringify({
      number: numberField(row, "number"),
      state: stringField(row, "state").toUpperCase(),
      mergeable: mergeableState(row),
      statusCheckRollup: [
        ...statuses.map((status) => ({ conclusion: stringField(status, "state").toUpperCase() })),
        ...runs.map((run) => ({
          status: stringField(run, "status").toUpperCase(),
          conclusion: stringField(run, "conclusion").toUpperCase(),
        })),
      ],
      url: stringField(row, "html_url"),
    }),
  };
}

function mergeableState(row: Record<string, unknown>): string {
  const state = stringField(row, "mergeable_state").toUpperCase();
  if (state && state !== "UNKNOWN") return state === "CLEAN" ? "MERGEABLE" : state;
  if (row.mergeable === true) return "MERGEABLE";
  if (row.mergeable === false) return "CONFLICTING";
  return "UNKNOWN";
}

async function listWaits(cwd: string): Promise<JsonObject[]> {
  const dir = await waitRegistryDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir).catch(() => []);
  const waits: JsonObject[] = [];
  for (const file of files.filter((name) => name.endsWith(".json") || name.endsWith(".toon"))) {
    const path = join(dir, file);
    const entry = parseStructuredRecord(await readFile(path, "utf8").catch(() => "{}"));
    const pid = typeof entry.pid === "number" ? entry.pid : 0;
    if (!pid || !pidAlive(pid)) {
      await rm(path, { force: true });
      continue;
    }
    waits.push(entry as JsonObject);
  }
  return waits;
}

async function waitRegistryDir(cwd: string): Promise<string> {
  return join(await repoRoot(cwd), ".red", "tmp", "waits");
}

async function repoRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".red")) || existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

async function writeStatus(path: string, entry: WaitRegistryEntry, status: WaitStatus): Promise<void> {
  await writeRegistryEntry(path, { ...entry, status }).catch(() => undefined);
}

async function writeRegistryEntry(path: string, entry: WaitRegistryEntry): Promise<void> {
  await writeFile(path, `${encodeSnapshotToon(entry as unknown as JsonObject)}\n`, "utf8");
}

async function signalCompletion(options: WaitOptions): Promise<void> {
  if (options.signalPid && Number.isInteger(options.signalPid) && options.signalPid > 0) {
    try {
      process.kill(options.signalPid, options.signal);
    } catch {}
  }
  if (options.notifyCmd?.trim()) {
    await new Promise<void>((resolveDone) => {
      const child = spawn(options.notifyCmd!, { shell: true, stdio: "ignore", detached: true });
      child.once("error", () => resolveDone());
      child.once("close", () => resolveDone());
    });
  }
}

function renderVerdict(kind: WaitKind, entry: WaitRegistryEntry, verdictValue: Verdict): JsonObject {
  return {
    wait: {
      id: entry.id,
      target: entry.target,
      kind,
      status: verdictValue.status,
      reason: entry.reason,
      started_at: entry.started_at,
      completed_at: new Date().toISOString(),
      poll_tier: entry.poll_tier,
    },
    verdict: {
      exit_code: verdictValue.exitCode,
      summary: verdictValue.summary,
      ...(verdictValue.details ? { details: verdictValue.details as JsonValue } : {}),
    },
  };
}

function verdict(status: "success" | "failure", summary: string, details: JsonObject): Verdict {
  return { status, exitCode: status === "success" ? 0 : 1, summary, details };
}

function waitTarget(parsed: ParsedWait): string {
  if (parsed.kind === "cmd") return `cmd:${parsed.commandLine ?? ""}`;
  if (parsed.kind === "run" && parsed.branch && parsed.latest) return `run:${parsed.branch}:latest`;
  if (parsed.kind === "release") return `release:${parsed.tagGlob ?? "*"}`;
  return `${parsed.kind}:${parsed.target ?? ""}`;
}

function checkState(value: unknown): "success" | "failure" | "pending" {
  const row = isRecord(value) ? value : {};
  const conclusion = String(row.conclusion ?? row.state ?? row.status ?? "").toLowerCase();
  if (["success", "successful", "passed", "completed", "neutral", "skipped"].includes(conclusion)) return "success";
  if (["failure", "failed", "error", "timed_out", "cancelled", "action_required"].includes(conclusion)) return "failure";
  return "pending";
}

function runDetails(row: Record<string, unknown>): JsonObject {
  return {
    database_id: typeof row.databaseId === "number" ? row.databaseId : String(row.databaseId ?? ""),
    conclusion: String(row.conclusion ?? ""),
    workflow: String(row.workflowName ?? ""),
    branch: String(row.headBranch ?? ""),
    url: String(row.url ?? ""),
  };
}

function parseRecord(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("expected JSON object");
  return parsed;
}

function parseStructuredRecord(raw: string): Record<string, unknown> {
  const body = raw.trim();
  if (!body) return {};
  try {
    return parseRecord(body);
  } catch {
    const parsed = decode(body);
    if (!isRecord(parsed)) throw new Error("expected structured object");
    return parsed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

function numberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  return typeof value === "number" ? value : 0;
}

function optionAfter(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error(`invalid timeout: ${value}`);
  const n = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return n;
  if (unit === "s") return n * 1_000;
  if (unit === "m") return n * 60_000;
  return n * 60 * 60_000;
}

function envDuration(name: string, fallbackMs: number): number {
  const value = process.env[name];
  if (!value) return fallbackMs;
  try {
    return parseDuration(value);
  } catch {
    return fallbackMs;
  }
}

function normalizeSignal(value: string): NodeJS.Signals {
  const signal = value.startsWith("SIG") ? value : `SIG${value}`;
  return signal as NodeJS.Signals;
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function globMatches(glob: string, value: string): boolean {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`).test(value);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
