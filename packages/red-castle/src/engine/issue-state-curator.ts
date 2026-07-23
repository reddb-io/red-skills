import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import type { EnginePaths } from "./paths.js";
import type { TrackerIssue, TrackerPort } from "./tracker/port.js";

export const ISSUE_CURATOR_RECHECK_LIMIT = 3;

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
  readonly nowMs?: number;
  readonly recheckLimit?: number;
}

export interface IssueStateCuratorResult {
  readonly checked: number;
  readonly released: number[];
  readonly parked: number[];
}

const QUARANTINE = "quarantine";
const READY = "ready-for-agent";
const HUMAN = "ready-for-human";
const INCOHERENT_STATE_LABELS = new Set([READY, HUMAN, "running", "needs-triage"]);

function activeCurrentBlocker(body: string): boolean {
  const match = /<!-- red:blocker-state v1 -->([\s\S]*?)<!-- \/red:blocker-state -->/.exec(body);
  return match !== null && /^status:\s*blocked\s*$/m.test(match[1] ?? "");
}

/** The curator re-runs the same issue-level coherence rule that caused
 * quarantine: no active Current blocker and no competing lifecycle/blocked
 * state may remain before the issue re-enters the executable queue. */
export function quarantineIncoherence(issue: TrackerIssue): string[] {
  const reasons: string[] = [];
  if (activeCurrentBlocker(issue.body)) reasons.push("active-current-blocker");
  for (const label of issue.labels) {
    if (INCOHERENT_STATE_LABELS.has(label) || label.startsWith("blocked:")) {
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
        encode(validated as unknown as JsonValue, { keyedMapCollapse: true }),
        "utf8",
      );
      await rename(temporary, path);
    },
  };
}

export async function runIssueStateCurator(
  input: IssueStateCuratorInput,
): Promise<IssueStateCuratorResult> {
  const nowMs = input.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const recheckLimit = input.recheckLimit ?? ISSUE_CURATOR_RECHECK_LIMIT;
  const prior = await input.store.read();
  const failedChecks = { ...prior.failedChecks };
  const issues = await input.tracker.listOpenIssuesByLabel(QUARANTINE);
  const released: number[] = [];
  const parked: number[] = [];

  for (const issue of issues) {
    const key = String(issue.number);
    const reasons = quarantineIncoherence(issue);
    if (reasons.length === 0) {
      try {
        if (!input.tracker.editIssueBody) throw new Error("tracker body mutation is not configured");
        await input.tracker.editIssueBody(issue.number, appendReleaseNote(issue, at));
        await input.tracker.editIssueLabels(issue.number, {
          remove: [QUARANTINE],
          add: [READY],
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
    try {
      await input.tracker.editIssueLabels(issue.number, {
        remove: [QUARANTINE, READY],
        add: [HUMAN],
      });
      delete failedChecks[key];
      parked.push(issue.number);
    } catch {
      // Preserve the counter at the threshold so the next sweep retries the park.
    }
  }

  await input.store.write({ version: 1, failedChecks });
  return { checked: issues.length, released, parked };
}
