import {
  LABEL_HUMAN,
  LABEL_QUARANTINE,
  LABEL_READY,
} from "../../core/triage-labels.js";
import type {
  QueueVisibilityProbeInput,
  QueueVisibilityTransportFailure,
  QueueVisibilityTransportSurface,
} from "../../core/operational-probes.js";
import type { ExecOutput } from "../exec.js";
import { listCandidates } from "./candidates.js";
import { isRecord, repoArgs, runGh, runRsp, type GhContext } from "./common.js";

async function countIssues(ctx: GhContext, args: string[]): Promise<number> {
  const r = await runGh(ctx, 
    ["issue", "list", ...repoArgs(ctx), "--state", "open", "--limit", "500", "--json", "number", ...args],
  );
  if (r.code !== 0) return 0;
  try {
    const parsed = JSON.parse(r.stdout) as unknown[];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export interface StatuslineQueueCounts {
  queue: number;
  human: number;
  quarantine: number;
}

function statuslineSearchQuery(repo: string, label: string): string {
  return `repo:${repo} is:issue is:open label:"${label}"`;
}

function queueVisibilityError(
  surface: QueueVisibilityTransportSurface,
  r: ExecOutput,
  message: string,
): Error & QueueVisibilityTransportFailure {
  return Object.assign(new Error(message), {
    surface,
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
  });
}

async function countOpenIssuesByLabelViaRest(ctx: GhContext, label: string): Promise<number> {
  if (!ctx.repo) return 0;
  const r = await runGh(ctx, [
    "api",
    "--method",
    "GET",
    "search/issues",
    "-f",
    `q=repo:${ctx.repo} is:issue is:open label:"${label}"`,
    "--jq",
    ".total_count",
  ]);
  if (r.code !== 0) throw queueVisibilityError("rest", r, "gh api REST issue search failed");
  const count = Number(r.stdout.trim());
  if (!Number.isFinite(count)) throw queueVisibilityError("rest", r, "gh api REST issue search returned a non-numeric count");
  return count;
}

export function queueVisibilityProbeInput(ctx: GhContext, label: string = LABEL_READY): QueueVisibilityProbeInput {
  return {
    label,
    listEngineCandidates: async () => {
      const failures: QueueVisibilityTransportFailure[] = [];
      const candidates = await listCandidates(ctx, label, {
        onTransportFailure: (failure) => failures.push(failure),
      });
      if (failures.length > 0 && candidates.length === 0) {
        const failure = failures[failures.length - 1];
        throw Object.assign(new Error(failure.message ?? "AFK engine candidate listing failed"), {
          surface: failure.surface,
          code: failure.code,
          stdout: failure.stdout,
          stderr: failure.stderr,
        });
      }
      return candidates.length;
    },
    countRestQueue: () => countOpenIssuesByLabelViaRest(ctx, label),
  };
}

async function countSearchViaRsp(ctx: GhContext, query: string): Promise<number | null> {
  const r = await runRsp(ctx, [
    "gh-api-json",
    "search/issues",
    "-f",
    `q=${query}`,
    "-f",
    "per_page=1",
  ]);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout || "{}") as unknown;
    if (!isRecord(parsed)) return null;
    return typeof parsed.total_count === "number" ? parsed.total_count : null;
  } catch {
    return null;
  }
}

/** Count both statusline queue buckets with one GraphQL search request. */
export async function countStatuslineQueueCounts(ctx: GhContext): Promise<StatuslineQueueCounts> {
  if (!ctx.repo) return { queue: 0, human: 0, quarantine: 0 };
  const [queue, human, quarantine] = await Promise.all([
    countSearchViaRsp(ctx, statuslineSearchQuery(ctx.repo, LABEL_READY)),
    countSearchViaRsp(ctx, statuslineSearchQuery(ctx.repo, LABEL_HUMAN)),
    countSearchViaRsp(ctx, statuslineSearchQuery(ctx.repo, LABEL_QUARANTINE)),
  ]);
  if (queue != null && human != null && quarantine != null) return { queue, human, quarantine };
  const query = `
    query($ready: String!, $human: String!, $quarantine: String!) {
      ready: search(type: ISSUE, query: $ready) { issueCount }
      human: search(type: ISSUE, query: $human) { issueCount }
      quarantine: search(type: ISSUE, query: $quarantine) { issueCount }
    }
  `;
  const r = await runGh(ctx, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `ready=${statuslineSearchQuery(ctx.repo, LABEL_READY)}`,
    "-F",
    `human=${statuslineSearchQuery(ctx.repo, LABEL_HUMAN)}`,
    "-F",
    `quarantine=${statuslineSearchQuery(ctx.repo, LABEL_QUARANTINE)}`,
  ]);
  if (r.code !== 0) return { queue: 0, human: 0, quarantine: 0 };
  try {
    const parsed = JSON.parse(r.stdout) as {
      data?: {
        ready?: { issueCount?: unknown };
        human?: { issueCount?: unknown };
        quarantine?: { issueCount?: unknown };
      };
    };
    return {
      queue: Number(parsed.data?.ready?.issueCount ?? 0),
      human: Number(parsed.data?.human?.issueCount ?? 0),
      quarantine: Number(parsed.data?.quarantine?.issueCount ?? 0),
    };
  } catch {
    return { queue: 0, human: 0, quarantine: 0 };
  }
}

/** Count issues that carry NO labels (the unlabeled straggler bucket). */
export async function countUnlabeled(ctx: GhContext): Promise<number> {
  const r = await runGh(ctx, 
    ["issue", "list", ...repoArgs(ctx), "--state", "open", "--limit", "500", "--json", "number,labels"],
  );
  if (r.code !== 0) return 0;
  try {
    const rows = JSON.parse(r.stdout) as Array<{ labels?: unknown[] }>;
    if (!Array.isArray(rows)) return 0;
    return rows.filter((row) => !Array.isArray(row.labels) || row.labels.length === 0).length;
  } catch {
    return 0;
  }
}

/** Count open `ready-for-agent` issues (the 📋 statusline queue count). */
export function countReadyForAgent(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", LABEL_READY]);
}

/** Count open `ready-for-human` issues (the 🆘 statusline count). */
export function countReadyForHuman(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", LABEL_HUMAN]);
}

/** Count `needs-triage` straggler issues. */
export function countNeedsTriage(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "needs-triage"]);
}

/** Count ALL open issues — the repo-global `is` statusline count (no label
 * filter). Capped at 500 like {@link countIssues}; a busier repo undercounts,
 * which is acceptable for a glanceable badge. */
export function countOpenIssues(ctx: GhContext): Promise<number> {
  return countIssues(ctx, []);
}

/** Count open pull requests — the repo-global `pr` statusline count. Mirrors
 * {@link countIssues} against `gh pr list`. Returns 0 on any gh/auth/parse
 * failure so the statusline stays fail-open. */
export async function countOpenPrs(ctx: GhContext): Promise<number> {
  const r = await runGh(ctx, [
    "pr",
    "list",
    ...repoArgs(ctx),
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number",
  ]);
  if (r.code !== 0) return 0;
  try {
    const parsed = JSON.parse(r.stdout) as unknown[];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Count pull requests created on the given local calendar day (YYYY-MM-DD).
 * Uses `--search created:<day>` as a server-side filter then re-filters by
 * local date in JS to absorb UTC/local-timezone boundary drift. Returns 0 on
 * any gh/auth/parse failure so the statusline stays fail-open. The `localDay`
 * parameter defaults to today's local date and is exposed for testing. */
export async function countPrsCreatedToday(
  ctx: GhContext,
  localDay = new Date().toLocaleDateString("en-CA"),
): Promise<number> {
  const r = await runGh(ctx, [
    "pr",
    "list",
    ...repoArgs(ctx),
    "--state",
    "all",
    "--limit",
    "100",
    "--json",
    "createdAt",
    "--search",
    `created:${localDay}`,
  ]);
  if (r.code !== 0) return 0;
  try {
    const parsed = JSON.parse(r.stdout) as Array<{ createdAt: string }>;
    if (!Array.isArray(parsed)) return 0;
    return parsed.filter(
      (pr) =>
        typeof pr.createdAt === "string" &&
        new Date(pr.createdAt).toLocaleDateString("en-CA") === localDay,
    ).length;
  } catch {
    return 0;
  }
}

/** Count `needs-info` straggler issues. */
export function countNeedsInfo(ctx: GhContext): Promise<number> {
  return countIssues(ctx, ["--label", "needs-info"]);
}
