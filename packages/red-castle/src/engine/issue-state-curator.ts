import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import type { EnginePaths } from "./paths.js";
import {
  isRefused,
  planTransition,
  stateRoleLabels,
  type StateTransitionLabels,
} from "./state-transition.js";
import type { TrackerIssue, TrackerPort } from "./tracker/port.js";

export const ISSUE_CURATOR_RECHECK_LIMIT = 3;

/** How many closed issues one sweep reconciles. The set is self-draining — a
 * reconciled issue no longer carries a state role, so it never lists again —
 * and the sweep repeats, so a bounded batch costs a bounded number of tracker
 * writes per pass without leaving residue behind permanently. */
export const ISSUE_CURATOR_CLOSED_RECONCILE_LIMIT = 25;

export interface IssueCuratorFailureRecord {
  readonly count: number;
  readonly lastCheckedAt: string;
}

export interface IssueCuratorState {
  readonly version: 1;
  readonly failedChecks: Record<string, IssueCuratorFailureRecord>;
}

export interface IssueCuratorStore {
  read(): Promise<IssueCuratorState>;
  write(state: IssueCuratorState): Promise<void>;
}

export interface IssueStateCuratorInput {
  readonly tracker: TrackerPort;
  readonly store: IssueCuratorStore;
  /** The host's label vocabulary — the curator owns no spellings (#2666). */
  readonly labels: StateTransitionLabels;
  /** The Park's canonical blocker parser, injected by the application owner. */
  readonly hasActiveCurrentBlocker: (body: string) => boolean;
  readonly nowMs?: number;
  readonly recheckLimit?: number;
  /** Closed issues reconciled per sweep; see
   * {@link ISSUE_CURATOR_CLOSED_RECONCILE_LIMIT}. */
  readonly closedReconcileLimit?: number;
}

export interface IssueStateCuratorResult {
  readonly checked: number;
  readonly released: number[];
  readonly parked: number[];
  /** Closed issues whose surviving engine state was stripped (#2749). */
  readonly reconciled: number[];
}

/** The lifecycle labels that must not coexist with `quarantine`. Sourced from
 * the injected vocabulary — the curator holds no label spellings of its own. */
function incoherentStateLabels(labels: StateTransitionLabels): Set<string> {
  return new Set([labels.ready, labels.human, labels.running, labels.needsTriage]);
}

/** The curator re-runs the same issue-level coherence rule that caused
 * quarantine: no active Current blocker and no competing lifecycle/blocked
 * state may remain before the issue re-enters the executable queue. */
export function quarantineIncoherence(
  issue: TrackerIssue,
  labels: StateTransitionLabels,
  hasActiveCurrentBlocker: (body: string) => boolean,
): string[] {
  const incoherent = incoherentStateLabels(labels);
  const reasons: string[] = [];
  if (hasActiveCurrentBlocker(issue.body)) reasons.push("active-current-blocker");
  for (const label of issue.labels) {
    if (incoherent.has(label) || label.startsWith(labels.blockedPrefix)) {
      reasons.push(`state-label:${label}`);
    }
  }
  return reasons;
}

function appendReleaseNote(issue: TrackerIssue, at: string): string {
  const marker = `<!-- afk:quarantine-release v1 issue=#${issue.number} -->`;
  if (issue.body.includes(marker)) return issue.body;
  return `${issue.body.replace(/\s+$/, "")}\n\n${marker}\n🤖 Quarantine curator auto-released after coherence was restored (${at}).\n`;
}

function validateState(value: unknown): IssueCuratorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("issue curator state must be a record");
  }
  const raw = value as Partial<IssueCuratorState>;
  if (raw.version !== 1 || !raw.failedChecks || typeof raw.failedChecks !== "object") {
    throw new Error("issue curator state must be version 1 with failedChecks");
  }
  const failedChecks: Record<string, IssueCuratorFailureRecord> = {};
  for (const [issue, record] of Object.entries(raw.failedChecks)) {
    if (!/^\d+$/.test(issue) || !record || typeof record !== "object") continue;
    const candidate = record as Partial<IssueCuratorFailureRecord>;
    if (!Number.isSafeInteger(candidate.count) || Number(candidate.count) < 1) continue;
    if (typeof candidate.lastCheckedAt !== "string") continue;
    failedChecks[issue] = {
      count: Number(candidate.count),
      lastCheckedAt: candidate.lastCheckedAt,
    };
  }
  return { version: 1, failedChecks };
}

export function issueCuratorStatePath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "issue-curator.toon");
}

export function createFileIssueCuratorStore(paths: EnginePaths): IssueCuratorStore {
  const path = issueCuratorStatePath(paths);
  return {
    async read() {
      try {
        return validateState(decode(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { version: 1, failedChecks: {} };
        }
        throw error;
      }
    },
    async write(state) {
      const validated = validateState(state);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await writeFile(
        temporary,
        encode(validated as unknown as JsonValue),
        "utf8",
      );
      await rename(temporary, path);
    },
  };
}

/**
 * Strip the engine state a CLOSED issue has no business carrying (#2749).
 *
 * A park is not terminal: parked work still lands — by a human merge of its PR,
 * by a later retake, by an adopt-branch landing — and when GitHub's own
 * PR-closes-issue mechanism performs the close, no engine code path is watching
 * to reconcile what the park left behind. The result is a closed issue recorded
 * as human-escalated forever, which is exactly the one-state-role violation
 * ADR 0122 rule 5 exists to make unconstructible. The DECISION is this sweep's;
 * the WRITE is the transition API's, so permanent markers (`spec:N`, `type:*`,
 * `priority:*`) are untouched by construction — the `close` plan names only
 * state roles, `running`, blocked reasons, and `req:*` edges.
 */
async function reconcileClosedIssues(
  input: IssueStateCuratorInput,
  limit: number,
): Promise<number[]> {
  const list = input.tracker.listClosedIssuesByAnyLabel;
  if (!list) return [];
  let closed: TrackerIssue[];
  try {
    closed = await list.call(input.tracker, stateRoleLabels(input.labels), limit);
  } catch {
    // A tracker read fault costs this pass, never the sweep; the next one retries.
    return [];
  }

  const reconciled: number[] = [];
  for (const issue of closed) {
    const plan = planTransition(issue.labels, { kind: "close" }, input.labels);
    if (isRefused(plan) || (plan.remove.length === 0 && plan.add.length === 0)) continue;
    try {
      await input.tracker.editIssueLabels(issue.number, {
        remove: [...plan.remove],
        add: [...plan.add],
      });
      reconciled.push(issue.number);
    } catch {
      // One unwritable issue keeps its residue; the next sweep retries it.
    }
  }
  return reconciled;
}

export async function runIssueStateCurator(
  input: IssueStateCuratorInput,
): Promise<IssueStateCuratorResult> {
  const nowMs = input.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const recheckLimit = input.recheckLimit ?? ISSUE_CURATOR_RECHECK_LIMIT;
  const prior = await input.store.read();
  const failedChecks = { ...prior.failedChecks };
  const labels = input.labels;
  const issues = await input.tracker.listOpenIssuesByLabel(labels.quarantine);
  const released: number[] = [];
  const parked: number[] = [];

  // The DECISION below is the curator's; the WRITE is the transition API's —
  // `planTransition` proves the one-state-role invariant before either mutation
  // reaches the tracker (#2666, ADR 0122 rule 5).
  for (const issue of issues) {
    const key = String(issue.number);
    const reasons = quarantineIncoherence(issue, labels, input.hasActiveCurrentBlocker);
    if (reasons.length === 0) {
      // A quarantined issue carrying live `req:*` edges without its wait state
      // is itself incoherent: the planner refuses the queue and the issue stays
      // held for the next sweep rather than re-entering the queue mid-blocked.
      const release = planTransition(issue.labels, { kind: "queue" }, labels);
      if (isRefused(release)) continue;
      try {
        if (!input.tracker.editIssueBody) throw new Error("tracker body mutation is not configured");
        await input.tracker.editIssueBody(issue.number, appendReleaseNote(issue, at));
        await input.tracker.editIssueLabels(issue.number, {
          remove: [...release.remove],
          add: [...release.add],
        });
        delete failedChecks[key];
        released.push(issue.number);
      } catch {
        // One unwritable issue remains quarantined; the resident keeps sweeping.
      }
      continue;
    }

    const count = (failedChecks[key]?.count ?? 0) + 1;
    failedChecks[key] = { count, lastCheckedAt: at };
    if (count < recheckLimit) continue;
    const park = planTransition(issue.labels, { kind: "human" }, labels);
    if (isRefused(park)) continue;
    try {
      await input.tracker.editIssueLabels(issue.number, {
        remove: [...park.remove],
        add: [...park.add],
      });
      delete failedChecks[key];
      parked.push(issue.number);
    } catch {
      // Preserve the counter at the threshold so the next sweep retries the park.
    }
  }

  const reconciled = await reconcileClosedIssues(
    input,
    input.closedReconcileLimit ?? ISSUE_CURATOR_CLOSED_RECONCILE_LIMIT,
  );
  // A closed issue is done being judged: its re-check counter is dead weight.
  for (const issue of reconciled) delete failedChecks[String(issue)];

  await input.store.write({ version: 1, failedChecks });
  return { checked: issues.length, released, parked, reconciled };
}
