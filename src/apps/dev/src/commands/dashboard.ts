import { buildDashboardReport, renderDashboardReport, type DashboardIssue, type DashboardPullRequest, type DashboardRelease } from "../core/dashboard.js";
import { collectMonitorInputs, resolveRepoContext } from "../runtime/wire.js";
import { execTool, type ExecFn } from "../runtime/exec.js";

interface DashboardFlags {
  json: boolean;
  periodDays: number;
}

function parseDashboardFlags(args: readonly string[]): DashboardFlags {
  let json = false;
  let periodDays = 30;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--period" || arg === "--period-days") {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      periodDays = parsePeriodDays(value);
      continue;
    }
    if (arg.startsWith("--period=")) {
      periodDays = parsePeriodDays(arg.slice("--period=".length));
      continue;
    }
    if (arg.startsWith("--period-days=")) {
      periodDays = parsePeriodDays(arg.slice("--period-days=".length));
      continue;
    }
    throw new Error(`unknown dashboard argument: ${arg}`);
  }
  return { json, periodDays };
}

function parsePeriodDays(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^([1-9][0-9]*)(d|day|days)?$/);
  if (!match) throw new Error(`invalid dashboard period: ${value}`);
  const days = Number(match[1]);
  if (!Number.isSafeInteger(days) || days < 1) throw new Error(`invalid dashboard period: ${value}`);
  return days;
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

async function ghJson<T>(exec: ExecFn, cwd: string, args: readonly string[]): Promise<T[]> {
  const out = await exec("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  if (out.code !== 0) return [];
  return parseJsonArray<T>(out.stdout);
}

function issueFrom(row: unknown): DashboardIssue {
  const rec = row as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    createdAt?: unknown;
    closedAt?: unknown;
    body?: unknown;
    labels?: unknown;
  };
  return {
    number: Number(rec.number ?? 0),
    title: typeof rec.title === "string" ? rec.title : "",
    state: typeof rec.state === "string" ? rec.state : "",
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : null,
    closedAt: typeof rec.closedAt === "string" ? rec.closedAt : null,
    body: typeof rec.body === "string" ? rec.body : null,
    labels: labelsFrom(rec.labels),
  };
}

function prFrom(row: unknown): DashboardPullRequest {
  const rec = row as {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    createdAt?: unknown;
    closedAt?: unknown;
    mergedAt?: unknown;
  };
  return {
    number: Number(rec.number ?? 0),
    title: typeof rec.title === "string" ? rec.title : "",
    state: typeof rec.state === "string" ? rec.state : "",
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : null,
    closedAt: typeof rec.closedAt === "string" ? rec.closedAt : null,
    mergedAt: typeof rec.mergedAt === "string" ? rec.mergedAt : null,
  };
}

function releaseFrom(row: unknown): DashboardRelease {
  const rec = row as {
    tag_name?: unknown;
    tagName?: unknown;
    published_at?: unknown;
    publishedAt?: unknown;
    draft?: unknown;
    isDraft?: unknown;
    prerelease?: unknown;
    isPrerelease?: unknown;
  };
  return {
    tagName: typeof rec.tagName === "string" ? rec.tagName : typeof rec.tag_name === "string" ? rec.tag_name : "",
    publishedAt: typeof rec.publishedAt === "string"
      ? rec.publishedAt
      : typeof rec.published_at === "string"
        ? rec.published_at
        : null,
    isDraft: typeof rec.isDraft === "boolean" ? rec.isDraft : rec.draft === true,
    isPrerelease: typeof rec.isPrerelease === "boolean" ? rec.isPrerelease : rec.prerelease === true,
  };
}

export async function dashboardCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  exec: ExecFn = execTool,
): Promise<number> {
  const flags = parseDashboardFlags(args);
  const ctx = await resolveRepoContext(cwd);
  const repoArgs = ctx.repo ? ["--repo", ctx.repo] : [];

  const [issueRows, prRows, releaseRows, monitor] = await Promise.all([
    ghJson<unknown>(exec, cwd, [
      "issue",
      "list",
      ...repoArgs,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,state,createdAt,closedAt,labels,body",
    ]),
    ghJson<unknown>(exec, cwd, [
      "pr",
      "list",
      ...repoArgs,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,state,createdAt,closedAt,mergedAt",
    ]),
    ctx.repo
      ? ghJson<unknown>(exec, cwd, ["api", `repos/${ctx.repo}/releases?per_page=100`])
      : Promise.resolve([]),
    collectMonitorInputs(cwd),
  ]);

  const live = monitor.workers.filter((worker) => worker.live).length;
  const report = buildDashboardReport({
    issues: issueRows.map(issueFrom).filter((issue) => issue.number > 0),
    pullRequests: prRows.map(prFrom).filter((pr) => pr.number > 0),
    releases: releaseRows.map(releaseFrom).filter((release) => release.tagName !== ""),
    localWorkers: {
      live,
      stale: monitor.workers.length - live,
      total: monitor.workers.length,
    },
    now: new Date(),
    periodDays: flags.periodDays,
  });

  if (!ctx.repo) {
    report.warnings.push("Could not resolve GitHub repo; GitHub-derived metrics are empty.");
  }

  stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderDashboardReport(report)}\n`);
  return 0;
}
