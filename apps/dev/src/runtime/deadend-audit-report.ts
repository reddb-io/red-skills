// deadend-audit-report.ts — build the live deadend audit from GitHub reads and
// local state, shared by the `deadend_audit` MCP tool and /red-doctor so both
// render byte-identical results (issue #2428).
//
// Every source below is a READ. The builder assembles a read-only
// DeadendAuditReader and hands it to the pure collector; it never mutates the
// repository or local state.

import {
  collectDeadendAudit,
  type CollectDeadendAuditOptions,
  type DeadendAuditReader,
} from "../core/deadend-audit-collect.js";
import type {
  DeadendAuditReport,
  DeadendClaim,
  DeadendIssue,
  DeadendPr,
  DeadendWorktree,
  IssueState,
} from "../core/deadend-audit.js";
import { issueFromAFKBranch } from "../core/boot-sweep.js";
import { parseClaimRecords } from "../core/claim.js";
import { LABEL_DEPENDENCY, LABEL_RUNNING } from "../core/triage-labels.js";
import { collectTmpJanitorReport } from "./tmp-janitor.js";
import {
  listCandidates,
  listHitlCandidates,
  listClaimComments,
  listIssueStates,
  type GhContext,
} from "./gh.js";
import { isRecord } from "./gh/common.js";
import { readGhJsonRows } from "./gh/read.js";
import { afkPaths, collectMonitorInputs, resolveRepoContext } from "./wire.js";

function issueStateOf(raw: string): IssueState {
  const upper = raw.toUpperCase();
  return upper === "CLOSED" ? "CLOSED" : upper === "OPEN" ? "OPEN" : "UNKNOWN";
}

/** Fold claim markers to the latest record per worker and keep active holders. */
function claimHolders(comments: { id: number; body: string; createdAt?: string }[]): string[] {
  const records = parseClaimRecords(
    comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt })),
  );
  const latest = new Map<string, { commentId: number; kind: string }>();
  for (const record of records) {
    const seen = latest.get(record.worker);
    if (!seen || record.commentId > seen.commentId) {
      latest.set(record.worker, { commentId: record.commentId, kind: record.kind });
    }
  }
  const holders: string[] = [];
  for (const [worker, record] of latest) {
    if (record.kind === "claim") holders.push(worker);
  }
  return holders;
}

interface RollupState {
  statusCheckRollup?: Array<{ conclusion?: string | null; state?: string | null }>;
}

function rollupIsRed(pr: RollupState): boolean {
  const rollup = pr.statusCheckRollup ?? [];
  return rollup.some((check) => {
    const verdict = String(check.conclusion ?? check.state ?? "").toUpperCase();
    return verdict === "FAILURE" || verdict === "ERROR" || verdict === "TIMED_OUT";
  });
}

/**
 * The audit's open-PR source. RAISES {@link GhReadError} when the read failed:
 * an audit that cannot see the open pull requests must say so, never report a
 * clean board because the query never ran (#2801).
 */
async function listOpenAfkPrs(gh: GhContext): Promise<Array<{ number: number; issue: number; red: boolean }>> {
  const rows = await readGhJsonRows<unknown>(gh, [
    "pr",
    "list",
    "--repo",
    gh.repo,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,headRefName,statusCheckRollup",
  ]);
  const out: Array<{ number: number; issue: number; red: boolean }> = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const branch = String(row.headRefName ?? "");
    const issue = issueFromAFKBranch(branch);
    if (issue === null) continue;
    out.push({
      number: Number(row.number),
      issue,
      red: rollupIsRed(row as RollupState),
    });
  }
  return out;
}

/**
 * Build the live deadend audit for `root`. Read-only end to end.
 */
export async function collectDeadendAuditReport(
  root: string,
  options: CollectDeadendAuditOptions = {},
): Promise<DeadendAuditReport> {
  const context = await resolveRepoContext(root);
  const gh: GhContext = { cwd: context.root, repo: context.repo };
  const paths = afkPaths(root);

  const reader: DeadendAuditReader = {
    now: () => Date.now(),

    async liveWorkers() {
      const monitor = await collectMonitorInputs(root);
      return monitor.workers
        .filter((worker) => worker.pidLive === true || worker.live === true)
        .map((worker) => worker.state.worker_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },

    async openIssues() {
      const [ready, human, states] = await Promise.all([
        listCandidates(gh),
        listHitlCandidates(gh),
        listIssueStates(gh),
      ]);
      const byNumber = new Map<number, { labels: Set<string>; body: string; updatedAt?: string }>();
      const merge = (number: number, labels: readonly string[], body?: string, updatedAt?: string) => {
        const entry = byNumber.get(number) ?? { labels: new Set<string>(), body: "" };
        for (const label of labels) entry.labels.add(label);
        if (body) entry.body = body;
        if (updatedAt) entry.updatedAt = updatedAt;
        byNumber.set(number, entry);
      };
      for (const candidate of ready) merge(candidate.number, candidate.labels, candidate.body);
      for (const candidate of human) {
        merge(candidate.number, candidate.labels, undefined, candidate.createdAt ?? undefined);
      }
      for (const [number, row] of states) {
        if (issueStateOf(row.state) !== "OPEN") continue;
        if (!row.labels.includes(LABEL_DEPENDENCY)) continue;
        merge(number, row.labels);
      }
      const issues: DeadendIssue[] = [];
      for (const [number, entry] of byNumber) {
        issues.push({
          number,
          labels: [...entry.labels],
          body: entry.body,
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        });
      }
      return issues;
    },

    async openPrs() {
      const [prs, states] = await Promise.all([listOpenAfkPrs(gh), listIssueStates(gh)]);
      const holderByIssue = new Map<number, string>();
      const runningIssues = [...states].filter(
        ([, row]) => issueStateOf(row.state) === "OPEN" && row.labels.includes(LABEL_RUNNING),
      );
      await Promise.all(
        runningIssues.map(async ([issue]) => {
          const holders = claimHolders(await listClaimComments(gh, issue));
          if (holders.length > 0) holderByIssue.set(issue, holders[0]!);
        }),
      );
      const out: DeadendPr[] = [];
      for (const pr of prs) {
        out.push({
          number: pr.number,
          issue: pr.issue,
          owner: holderByIssue.get(pr.issue) ?? "",
          checksRed: pr.red,
        });
      }
      return out;
    },

    async claims() {
      const states = await listIssueStates(gh);
      const runningIssues = [...states].filter(
        ([, row]) => issueStateOf(row.state) === "OPEN" && row.labels.includes(LABEL_RUNNING),
      );
      const out: DeadendClaim[] = [];
      await Promise.all(
        runningIssues.map(async ([issue]) => {
          for (const worker of claimHolders(await listClaimComments(gh, issue))) {
            out.push({ issue, worker });
          }
        }),
      );
      return out;
    },

    async worktrees() {
      const states = await listIssueStates(gh);
      const report = await collectTmpJanitorReport(
        paths.tmpDir,
        Math.floor(Date.now() / 1000),
        (issue) => issueStateOf(states.get(issue)?.state ?? "UNKNOWN"),
      );
      const out: DeadendWorktree[] = [];
      for (const entry of report.orphanFeedback.reclaim) {
        out.push({ lane: "feedback", path: entry.path, live: false });
      }
      return out;
    },

    async issueStates() {
      const states = await listIssueStates(gh);
      const out = new Map<number, IssueState>();
      for (const [number, row] of states) out.set(number, issueStateOf(row.state));
      return out;
    },
  };

  return collectDeadendAudit(reader, options);
}
