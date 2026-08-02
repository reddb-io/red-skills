import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LABEL_HUMAN } from "../core/triage-labels.js";
import {
  activityReviewInterval,
  buildActivityReviewReport,
  renderActivityReviewReport,
  renderActivityReviewReportToon,
  type ActivityReviewActiveWorker,
  type ActivityReviewComment,
  type ActivityReviewGitStats,
  type ActivityReviewIssue,
  type ActivityReviewKind,
  type ActivityReviewPullRequest,
  type ActivityReviewReport,
  type ActivityReviewTokenSummary,
} from "../core/activity-review.js";
import {
  parseLaneSinceCursor,
  ToonlCursorInvalidationError,
  type ToonlLaneCursor,
} from "../core/jsonl-log.js";
import { readHistoryRecords, type HistoryRecord } from "../core/history.js";
import { collectMonitorInputs, afkPaths, resolveRepoContext } from "../runtime/wire.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../core/toon-snapshot.js";

/** Output format. TOON is the default agent-facing wire format (PRD #928 / ADR
 * 0081); `--json` forces raw JSON (tooling/escape hatch), `--human` the prose. */
type ActivityReviewFormat = "toon" | "json" | "human";

interface ActivityReviewFlags {
  format: ActivityReviewFormat;
}

function parseFlags(args: readonly string[]): ActivityReviewFlags {
  let format: ActivityReviewFormat = "toon";
  for (const arg of args) {
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--toon") {
      format = "toon";
      continue;
    }
    if (arg === "--human") {
      format = "human";
      continue;
    }
    throw new Error(`unknown activity-review argument: ${arg}`);
  }
  return { format };
}

function labelsFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((label) => {
    const rec = label as { name?: unknown };
    return typeof rec.name === "string" ? rec.name : "";
  }).filter(Boolean);
}

function parseJsonArray<T>(raw: string, fallback: T[] = []): T[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

async function ghJsonArray<T>(exec: ExecFn, cwd: string, args: readonly string[]): Promise<T[]> {
  const out = await exec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (out.code !== 0) return [];
  return parseJsonArray<T>(out.stdout);
}

async function ghJsonObject<T>(exec: ExecFn, cwd: string, args: readonly string[], fallback: T): Promise<T> {
  const out = await exec("gh", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (out.code !== 0) return fallback;
  return parseJsonObject<T>(out.stdout, fallback);
}

function issueFrom(row: unknown): ActivityReviewIssue {
  const rec = row as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    createdAt?: unknown;
    closedAt?: unknown;
    body?: unknown;
    url?: unknown;
    labels?: unknown;
  };
  return {
    number: Number(rec.number ?? 0),
    title: typeof rec.title === "string" ? rec.title : "",
    state: typeof rec.state === "string" ? rec.state : "",
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : null,
    closedAt: typeof rec.closedAt === "string" ? rec.closedAt : null,
    body: typeof rec.body === "string" ? rec.body : null,
    url: typeof rec.url === "string" ? rec.url : null,
    labels: labelsFrom(rec.labels),
  };
}

function prFrom(row: unknown): ActivityReviewPullRequest {
  const rec = row as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    createdAt?: unknown;
    closedAt?: unknown;
    mergedAt?: unknown;
    url?: unknown;
  };
  return {
    number: Number(rec.number ?? 0),
    title: typeof rec.title === "string" ? rec.title : "",
    state: typeof rec.state === "string" ? rec.state : "",
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : null,
    closedAt: typeof rec.closedAt === "string" ? rec.closedAt : null,
    mergedAt: typeof rec.mergedAt === "string" ? rec.mergedAt : null,
    url: typeof rec.url === "string" ? rec.url : null,
  };
}

function commentFrom(row: unknown): ActivityReviewComment {
  const rec = row as { body?: unknown; createdAt?: unknown; author?: { login?: unknown } };
  return {
    body: typeof rec.body === "string" ? rec.body : "",
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : null,
    author: typeof rec.author?.login === "string" ? rec.author.login : null,
  };
}

function dateInRange(value: string | null | undefined, start: Date, end: Date): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

function shouldFetchIssueComments(issue: ActivityReviewIssue, start: Date, end: Date): boolean {
  const labels = issue.labels.map((label) => label.toLowerCase());
  return (
    dateInRange(issue.createdAt, start, end) ||
    dateInRange(issue.closedAt, start, end) ||
    labels.includes(LABEL_HUMAN) ||
    labels.some((label) => label.startsWith("blocked:"))
  );
}

async function withIssueComments(
  exec: ExecFn,
  cwd: string,
  repoArgs: readonly string[],
  issues: ActivityReviewIssue[],
  start: Date,
  end: Date,
): Promise<ActivityReviewIssue[]> {
  const selected = issues.filter((issue) => shouldFetchIssueComments(issue, start, end));
  const commentsByIssue = new Map<number, ActivityReviewComment[]>();
  await Promise.all(selected.map(async (issue) => {
    const row = await ghJsonObject<{ comments?: unknown }>(
      exec,
      cwd,
      ["issue", "view", String(issue.number), ...repoArgs, "--json", "comments"],
      {},
    );
    const comments = Array.isArray(row.comments) ? row.comments.map(commentFrom).filter((c) => c.body !== "") : [];
    commentsByIssue.set(issue.number, comments);
  }));
  return issues.map((issue) => ({ ...issue, comments: commentsByIssue.get(issue.number) ?? [] }));
}

export function parseGitLogStats(text: string): ActivityReviewGitStats {
  let commits = 0;
  let added = 0;
  let removed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("commit:")) {
      commits += 1;
      continue;
    }
    const insertions = line.match(/(\d+) insertions?\(\+\)/);
    const deletions = line.match(/(\d+) deletions?\(-\)/);
    if (insertions) added += Number(insertions[1]);
    if (deletions) removed += Number(deletions[1]);
  }
  return { commits, added, removed };
}

async function collectGitStats(exec: ExecFn, cwd: string, start: Date, end: Date): Promise<ActivityReviewGitStats> {
  const out = await exec("git", [
    "log",
    "--all",
    "--since",
    start.toISOString(),
    "--until",
    end.toISOString(),
    "--shortstat",
    "--format=commit:%H",
  ], { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (out.code !== 0) return { commits: 0, added: 0, removed: 0 };
  return parseGitLogStats(out.stdout);
}

function asPositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function collectTokensFromObject(value: unknown): { input: number; output: number; total: number; hits: number } {
  let input = 0;
  let output = 0;
  let total = 0;
  let hits = 0;
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;
      try {
        visit(JSON.parse(trimmed));
      } catch {
        // Old raw firehose records carried arbitrary text in `msg`; only parse
        // JSON-looking strings so regular output remains advisory and ignored.
      }
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, raw] of Object.entries(node)) {
      const normalized = key.replace(/[-_]/g, "").toLowerCase();
      const n = asPositiveNumber(raw);
      if (n !== null) {
        if (normalized === "inputtokens" || normalized === "prompttokens" || normalized === "totalinputtokens") {
          input += n;
          hits += 1;
        } else if (normalized === "outputtokens" || normalized === "completiontokens" || normalized === "totaloutputtokens") {
          output += n;
          hits += 1;
        } else if (normalized === "totaltokens") {
          total += n;
          hits += 1;
        }
      }
      visit(raw);
    }
  };
  visit(value);
  return { input, output, total, hits };
}

interface TokenCacheRow {
  ts: string | null;
  input: number;
  output: number;
  total: number;
}

interface TokenFileCache {
  cursor: ToonlLaneCursor;
  rows: TokenCacheRow[];
}

type TokenSummaryCache = Record<string, TokenFileCache>;

/**
 * The per-file map is nested under one envelope key rather than written at the document root.
 * toon 0.13.0 reserves `order`, `discriminator` and `rows` as the cyclic-array wire's meta keys and
 * tests for them **one level below the root**, so a root-level map of `{cursor, rows}` entries
 * decodes as a malformed cyclic section — `invalid cyclic array wire` — in both the bundled encoder's
 * own decoder and pinned `tq`. The envelope pushes our field names to depth two, where they are
 * ordinary keys again. Do not flatten this back (issue #3072).
 */
const TOKEN_CACHE_ENVELOPE_KEY = "files";

function tokenCachePath(workersRoot: string): string {
  return join(workersRoot, ".activity-review-token-cursors.json");
}

function validTokenCacheRow(value: unknown): TokenCacheRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const input = Number(rec.input);
  const output = Number(rec.output);
  const total = Number(rec.total);
  if (!Number.isFinite(input) || input < 0) return null;
  if (!Number.isFinite(output) || output < 0) return null;
  if (!Number.isFinite(total) || total < 0) return null;
  return {
    ts: typeof rec.ts === "string" ? rec.ts : null,
    input,
    output,
    total,
  };
}

function validToonlCursor(value: unknown): ToonlLaneCursor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Partial<ToonlLaneCursor>;
  const byteOffset = Number(rec.byteOffset);
  const rowsSinceHeader = Number(rec.rowsSinceHeader);
  if (!Number.isFinite(byteOffset) || byteOffset < 0) return null;
  if (!Number.isFinite(rowsSinceHeader) || rowsSinceHeader < 0) return null;
  return {
    byteOffset,
    rowsSinceHeader,
    activeHeader: typeof rec.activeHeader === "string" ? rec.activeHeader : "",
    taggedHeaders:
      rec.taggedHeaders !== null && typeof rec.taggedHeaders === "object"
        ? Object.fromEntries(
            Object.entries(rec.taggedHeaders as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {},
  };
}

function validTokenFileCache(value: unknown): TokenFileCache | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as { cursor?: unknown; rows?: unknown };
  const cursor = validToonlCursor(rec.cursor);
  if (cursor === null || !Array.isArray(rec.rows)) return null;
  return {
    cursor,
    rows: rec.rows.map(validTokenCacheRow).filter((row): row is TokenCacheRow => row !== null),
  };
}

async function readTokenSummaryCache(path: string): Promise<TokenSummaryCache> {
  try {
    const parsed = decodeDevSnapshotSniff(await readFile(path, "utf8")) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const envelope = parsed[TOKEN_CACHE_ENVELOPE_KEY];
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return {};
    const out: TokenSummaryCache = {};
    for (const [file, value] of Object.entries(envelope as Record<string, unknown>)) {
      const cache = validTokenFileCache(value);
      if (cache !== null) out[file] = cache;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeTokenSummaryCache(path: string, cache: TokenSummaryCache): Promise<void> {
  const document = { [TOKEN_CACHE_ENVELOPE_KEY]: cache };
  await writeFile(path, encodeDevSnapshotToon(document as unknown as Parameters<typeof encodeDevSnapshotToon>[0]), "utf8");
}

async function listRetainedLogFiles(workersRoot: string): Promise<string[]> {
  const out: string[] = [];
  let workers: string[];
  try {
    workers = await readdir(workersRoot);
  } catch {
    return out;
  }
  for (const worker of workers) {
    let attempts: string[];
    try {
      attempts = await readdir(join(workersRoot, worker));
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      out.push(join(workersRoot, worker, attempt, "log.toonl"));
      out.push(join(workersRoot, worker, attempt, "agent.log.toonl"));
    }
  }
  return out;
}

function timestampFromLogRecord(value: unknown): Date | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  for (const key of ["ts", "createdAt", "created_at", "timestamp", "time"]) {
    const raw = rec[key];
    if (typeof raw !== "string") continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function logRecordInInterval(value: unknown, start: Date, end: Date): boolean {
  const ts = timestampFromLogRecord(value);
  if (ts === null) return true;
  return ts.getTime() >= start.getTime() && ts.getTime() <= end.getTime();
}

export async function collectTokenSummary(workersRoot: string, start: Date, end: Date): Promise<ActivityReviewTokenSummary> {
  let input = 0;
  let output = 0;
  let total = 0;
  let sourceRecords = 0;
  const files = await listRetainedLogFiles(workersRoot);
  const cachePath = tokenCachePath(workersRoot);
  const previous = await readTokenSummaryCache(cachePath);
  const next: TokenSummaryCache = {};
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const prior = previous[file];
    let parsed: ReturnType<typeof parseLaneSinceCursor>;
    let rows = prior?.rows ?? [];
    try {
      parsed = parseLaneSinceCursor(text, prior?.cursor);
    } catch (err) {
      if (!(err instanceof ToonlCursorInvalidationError)) throw err;
      parsed = parseLaneSinceCursor(text);
      rows = [];
    }
    for (const record of parsed.records) {
      const found = collectTokensFromObject(record);
      if (found.hits > 0) {
        rows.push({
          ts: timestampFromLogRecord(record)?.toISOString() ?? null,
          input: found.input,
          output: found.output,
          total: found.total,
        });
      }
    }
    next[file] = { cursor: parsed.cursor, rows };
    for (const row of rows) {
      if (!logRecordInInterval({ ts: row.ts }, start, end)) continue;
      input += row.input;
      output += row.output;
      total += row.total;
      sourceRecords += 1;
    }
  }
  await writeTokenSummaryCache(cachePath, next).catch(() => undefined);
  const available = sourceRecords > 0;
  return {
    available,
    total: available && total > 0 ? total : null,
    input: available && input > 0 ? input : null,
    output: available && output > 0 ? output : null,
    sourceRecords,
  };
}

function activeWorkerFromMonitor(worker: Awaited<ReturnType<typeof collectMonitorInputs>>["workers"][number]): ActivityReviewActiveWorker {
  const number = worker.state.current.number;
  const issue = typeof number === "number" ? number : Number(number);
  return {
    worker: worker.state.worker_id,
    runner: worker.state.runner,
    issue: Number.isFinite(issue) && issue > 0 ? issue : null,
    title: worker.state.current.title,
    startedAt: worker.state.current.started_at || worker.state.started_at || null,
    live: worker.live,
  };
}

/**
 * Value-returning activity-review core: gather the GitHub/git/monitor/history/token
 * facts for the review window and build the {@link ActivityReviewReport}. The CLI
 * command renders it (TOON/JSON/human); the MCP `daily_review`/`weekly_review` ops
 * return it verbatim (TOON-encoded at the transport boundary). No stdout.
 */
export async function collectActivityReview(
  kind: ActivityReviewKind,
  opts: { cwd?: string; exec?: ExecFn } = {},
): Promise<ActivityReviewReport> {
  const cwd = opts.cwd ?? process.cwd();
  const exec = opts.exec ?? execTool;
  const now = new Date();
  const interval = activityReviewInterval(kind, now);
  const ctx = await resolveRepoContext(cwd);
  const repoArgs = ctx.repo ? ["--repo", ctx.repo] : [];
  const paths = afkPaths(cwd);

  const [issueRows, prRows, gitStats, monitor, history, tokenSummary] = await Promise.all([
    ghJsonArray<unknown>(exec, cwd, [
      "issue",
      "list",
      ...repoArgs,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,state,createdAt,closedAt,labels,body,url",
    ]),
    ghJsonArray<unknown>(exec, cwd, [
      "pr",
      "list",
      ...repoArgs,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,state,createdAt,closedAt,mergedAt,url",
    ]),
    collectGitStats(exec, cwd, interval.start, interval.end),
    collectMonitorInputs(cwd),
    readHistoryRecords(paths.historyPath, { read: async (path) => readFile(path, "utf8").catch(() => null) }),
    collectTokenSummary(paths.workersRoot, interval.start, interval.end),
  ]);

  const issues = await withIssueComments(
    exec,
    cwd,
    repoArgs,
    issueRows.map(issueFrom).filter((issue) => issue.number > 0),
    interval.start,
    interval.end,
  );
  const report = buildActivityReviewReport({
    kind,
    now,
    issues,
    pullRequests: prRows.map(prFrom).filter((pr) => pr.number > 0),
    gitStats,
    history,
    activeWorkers: monitor.workers.map(activeWorkerFromMonitor),
    tokenSummary,
  });

  if (!ctx.repo) {
    report.warnings.push("Could not resolve GitHub repo; GitHub-derived metrics may be empty.");
  }
  return report;
}

export async function activityReviewCommand(
  kind: ActivityReviewKind,
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  exec: ExecFn = execTool,
): Promise<number> {
  const flags = parseFlags(args);
  const report = await collectActivityReview(kind, { cwd, exec });

  const rendered =
    flags.format === "json"
      ? JSON.stringify(report, null, 2)
      : flags.format === "human"
        ? renderActivityReviewReport(report)
        : renderActivityReviewReportToon(report);
  stdout.write(`${rendered}\n`);
  return 0;
}
