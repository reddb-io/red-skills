// runtime/gh/manager-map.ts — Manager map publication I/O layer
// (Spec #2290, slices #2294 and #2295).
//
// The pure plan lives in core/manager/map-reconciler.ts; this module executes
// it against GitHub. Each step is independently idempotent:
//   1. Find the map by marker — returns the existing one or null.
//   2. If not found, create one.
//   3. Apply any missing labels.
//   4. Read native sub-issues.
// A partial failure re-runs from step 1 and converges with no rollback.
//
// Slice #2295 adds two more functions:
//   dispatchExecutionIssue  — create a tracker issue for autonomous execution.
//   readExecutionArtifact   — reconcile the dispatched issue state as untrusted
//                             evidence (never a directive; Decision #2184).

import { scrubOutbound } from "../outbound-redaction.js";
import { planGithubRestRead, planGithubWrite } from "@reddb-io/github";
import { apiPath, githubReadClient, githubRepo, repoArgs, runGh, type GhContext } from "./common.js";
import {
  buildMapBody,
  buildMapTitle,
  computeDerivedState,
  computeDesiredLabels,
  computeLabelsToAdd,
  extractEffortIdFromBody,
  type ExecutionArtifact,
  type ManagerMapDerivedState,
} from "../../core/manager/map-reconciler.js";
import type { EffortRecord } from "../../core/manager/effort-store.js";
import { LABEL_READY } from "../../core/triage-labels.js";

/** A single manager map issue as read from the tracker. */
export interface ManagerMapIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

function createdIssueNumber(stdout: string): number {
  const urlMatch = stdout.match(/\/issues\/(\d+)\b/);
  if (urlMatch) return Number(urlMatch[1]);
  try {
    const parsed = JSON.parse(stdout) as { number?: unknown };
    return Number(parsed.number ?? 0);
  } catch {
    return NaN;
  }
}

/**
 * Search for an existing Manager map by the effort-ID marker in its body.
 * Returns null when none is found or when the search fails — the caller then
 * creates a new map. The body is verified against the canonical marker pattern
 * to rule out false positives from the full-text search.
 */
export async function findManagerMapByEffortId(
  ctx: GhContext,
  effortId: string,
): Promise<ManagerMapIssue | null> {
  const repo = githubRepo(ctx);
  if (!repo) return null;
  let rows: Array<{ number?: unknown; title?: unknown; body?: unknown; labels?: unknown }>;
  try {
    const answer = await githubReadClient(ctx).conditionalRest<{
      items?: Array<{ number?: unknown; title?: unknown; body?: unknown; labels?: unknown }>;
    }>({
      cacheKey: `manager-map:search:${ctx.repo}:${effortId}`,
      route: "GET /search/issues",
      parameters: {
        q: `repo:${ctx.repo} in:body "manager-map effort-id=${effortId}"`,
        per_page: 10,
      },
      operation: { key: "issue list", budget: "rest" },
      actor: "manager-map",
    });
    rows = Array.isArray(answer.data.items) ? answer.data.items : [];
  } catch {
    return null;
  }
  const match = rows.find((row) => extractEffortIdFromBody(String(row.body ?? "")) === effortId);
  if (!match) return null;
  return {
    number: Number(match.number ?? 0),
    title: String(match.title ?? ""),
    body: String(match.body ?? ""),
    labels: Array.isArray(match.labels)
      ? (match.labels as Array<{ name?: unknown }>).map((l) => String(l.name ?? ""))
      : [],
  };
}

/** List the native sub-issues of a Manager map by paginated GitHub API. */
async function listMapChildren(ctx: GhContext, mapNumber: number): Promise<number[]> {
  const repo = githubRepo(ctx);
  if (!repo) return [];
  try {
    const answer = await githubReadClient(ctx).conditionalPaginate<{ number?: unknown }>({
      cacheKey: `manager-map:children:${ctx.repo}:${mapNumber}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      parameters: { ...repo, issue_number: mapNumber, per_page: 100 },
      operation: { key: "api rest", budget: "rest" },
      actor: "manager-map",
    });
    return answer.data
      .map((child) => Number(child.number ?? 0))
      .filter((number) => Number.isInteger(number) && number > 0);
  } catch {
    return [];
  }
}

/**
 * Publish the Manager map idempotently and reconcile derived state.
 *
 * Declarative converge — each step is independently idempotent and a partial
 * failure re-runs cleanly from step 1. No rollback is ever performed.
 *
 * Step 1: Find the existing map by effort-ID marker.
 * Step 2: If absent, create the map issue (title + body + label).
 * Step 3: Apply any missing labels to an existing map.
 * Step 4: Read native sub-issues.
 * Step 5: Return derived state for the brief.
 */
export async function publishAndReconcileManagerMap(
  ctx: GhContext,
  effort: EffortRecord,
): Promise<ManagerMapDerivedState> {
  // Step 1: find
  const existing = await findManagerMapByEffortId(ctx, effort.effort_id);
  let mapNumber: number;

  if (!existing) {
    // Step 2: create
    const labelArgs = computeDesiredLabels().flatMap((l) => ["--label", l]);
    const write = planGithubWrite(["gh",
      "issue",
      "create",
      ...repoArgs(ctx),
      "--title",
      scrubOutbound(buildMapTitle(effort)),
      "--body",
      scrubOutbound(buildMapBody(effort)),
      ...labelArgs,
    ]);
    const r = await runGh(ctx, write.args.slice(1));
    const num = createdIssueNumber(r.stdout ?? "");
    if (r.code !== 0 || !Number.isInteger(num) || num <= 0) {
      throw new Error(
        `gh: failed to create manager map for effort ${effort.effort_id} (code ${r.code})`,
      );
    }
    mapNumber = num;
  } else {
    mapNumber = existing.number;
    // Step 3: apply missing labels
    const toAdd = computeLabelsToAdd(existing.labels, computeDesiredLabels());
    if (toAdd.length > 0) {
      const args = ["gh", "issue", "edit", String(mapNumber), ...repoArgs(ctx)];
      for (const label of toAdd) args.push("--add-label", label);
      const write = planGithubWrite(args, { currentIssueLabels: existing.labels });
      await runGh(ctx, write.args.slice(1));
    }
  }

  // Step 4: read children
  const children = await listMapChildren(ctx, mapNumber);

  // Step 5: return derived state
  return computeDerivedState(mapNumber, children);
}

/**
 * Dispatch an autonomous execution issue for the effort.
 *
 * Creates a `ready-for-agent` tracker issue whose intent is the effort's
 * published intent. If the map has already been published, links the new issue
 * as a native sub-issue. Returns the new issue number.
 *
 * The caller saves the returned number to the effort record as `dispatch_issue`
 * so future `status` reconciles can read back its tracker state as untrusted
 * evidence (Decision #2184, Spec #2290 slice #2295).
 */
export async function dispatchExecutionIssue(
  ctx: GhContext,
  effort: EffortRecord,
  mapNumber: number | null,
): Promise<number> {
  const title = scrubOutbound(`[manager] ${effort.name}: autonomous execution`);
  const body = scrubOutbound(
    `${buildEffortMarker(effort.effort_id)}\n\n**Intent:** ${effort.intent}`,
  );
  const create = planGithubWrite(["gh",
    "issue",
    "create",
    ...repoArgs(ctx),
    "--title",
    title,
    "--body",
    body,
    "--label",
    LABEL_READY,
  ]);
  const r = await runGh(ctx, create.args.slice(1));
  const num = createdIssueNumber(r.stdout ?? "");
  if (r.code !== 0 || !Number.isInteger(num) || num <= 0) {
    throw new Error(
      `gh: failed to create execution issue for effort ${effort.effort_id} (code ${r.code})`,
    );
  }
  // Link the execution issue as a sub-issue of the map when available.
  if (mapNumber !== null) {
    const link = planGithubWrite(["gh",
      "api",
      "-X",
      "POST",
      apiPath(ctx, `issues/${mapNumber}/sub_issues`),
      "-F",
      `sub_issue_id=${num}`,
    ]);
    await runGh(ctx, link.args.slice(1));
  }
  return num;
}

/** Build the effort-ID marker for embedding in the execution issue body. */
function buildEffortMarker(effortId: string): string {
  return `<!-- red-skills:manager-map effort-id=${effortId} v1 -->`;
}

/**
 * Reconcile the tracker state of a dispatched execution issue as UNTRUSTED
 * EVIDENCE (Decision #2184, Spec #2290 slice #2295).
 *
 * Returns the issue's current state (open/closed) and labels from the tracker.
 * Returns null when the issue cannot be read — the brief renders without it.
 *
 * This data is NEVER stored: it is read at render time, classified as untrusted
 * evidence, and included in the brief only as a signal — never as a directive.
 */
export async function readExecutionArtifact(
  ctx: GhContext,
  issueNumber: number,
): Promise<ExecutionArtifact | null> {
  const repo = githubRepo(ctx);
  if (!repo) return null;
  const plan = planGithubRestRead({
    kind: "issue",
    number: issueNumber,
    fields: ["number", "state", "labels"],
    repo: ctx.repo,
  });
  if (plan.outcome !== "plan") return null;
  let parsed: { number?: unknown; state?: unknown; labels?: unknown };
  try {
    const answer = await githubReadClient(ctx).conditionalRest<unknown>({
      cacheKey: `manager-map:execution:${ctx.repo}:${issueNumber}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
      parameters: { ...repo, issue_number: issueNumber },
      operation: { key: "issue view", budget: "rest" },
      actor: "manager-map",
    });
    parsed = plan.decode(JSON.stringify(answer.data)) as typeof parsed;
  } catch {
    return null;
  }
  const state = String(parsed.state ?? "").toLowerCase();
  if (state !== "open" && state !== "closed") return null;
  const labels = Array.isArray(parsed.labels)
    ? (parsed.labels as Array<{ name?: unknown }>).map((l) => String(l.name ?? ""))
    : [];
  return {
    issue_number: issueNumber,
    state: state as "open" | "closed",
    labels,
    pr_numbers: [],
  };
}
