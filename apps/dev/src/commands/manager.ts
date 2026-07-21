// commands/manager.ts — the operator front door of the Manager (Spec #2290,
// slices #2291, #2292, #2295; architecture in ADR 0109).
//
// Five shapes:
//   `manager <intent>`         — mint an effort from the intent and persist it.
//   `manager status [id]`      — render the brief for one effort (newest by default).
//   `manager resume [id]`      — transition inbox/paused effort → active, acquire lease.
//   `manager end [id]`         — transition active effort → completed, release lease.
//   `manager dispatch [id]`    — dispatch an autonomous execution for the effort and
//                                record the tracker issue number (slice #2295).
//
// The command is conversation-first: anything that is not a lifecycle keyword IS
// the intent. Routing and reconciliation happen at render time via the GH layer.

import { homedir } from "node:os";
import { resolveManagerRoot } from "@reddb-io/shared/red-paths.js";
import {
  renderEffortBrief,
  renderEffortBriefWithDerived,
  renderEmptyPortfolioBrief,
} from "../core/manager/brief.js";
import {
  ManagerStoreError,
  latestEffort,
  readEffort,
  saveEffort,
  startEffort,
} from "../core/manager/effort-store.js";
import { endEffort, manageEffort } from "../core/manager/effort-lease.js";
import {
  dispatchExecutionIssue,
  readExecutionArtifact,
} from "../runtime/gh/manager-map.js";
import type { ExecFn } from "../runtime/exec.js";
import { computeDerivedState } from "../core/manager/map-reconciler.js";

export interface ManagerCommandDeps {
  /** The directory that CONTAINS `.red/manager`; defaults to the operator home. */
  root?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
  /** Injected host name, so tests can pin it without touching `os.hostname()`. */
  host?: string;
  /**
   * GH context for dispatch and reconcile (slice #2295).
   * When present, `dispatch` creates a tracker issue and `status` reconciles the
   * execution artifact state from the tracker as untrusted evidence.
   */
  gh?: {
    exec?: ExecFn;
    repo: string;
    cwd: string;
  };
}

const USAGE = [
  "usage: afk manager <intent>          start an effort from an intent",
  "       afk manager status [effort]   render an effort brief (default: the newest)",
  "       afk manager resume [effort]   transition an effort to active and acquire the lease",
  "       afk manager end [effort]      transition an active effort to completed",
  "       afk manager dispatch [effort] dispatch autonomous execution for the effort",
].join("\n");

const LIFECYCLE_WORDS = new Set(["status", "resume", "end", "dispatch"]);

function resolveRoot(deps: ManagerCommandDeps): string {
  return deps.root ?? resolveManagerRoot({ homeDir: homedir(), env: process.env });
}

async function resolveEffort(
  effortId: string | undefined,
  root: string,
  fail: (text: string) => void,
) {
  const effort = effortId ? await readEffort(root, effortId) : await latestEffort(root);
  if (!effort) {
    if (effortId) {
      fail(`[manager] no effort ${effortId} in this portfolio\n`);
    } else {
      fail("[manager] no effort in this portfolio; start one with: afk manager <intent>\n");
    }
    return null;
  }
  return effort;
}

async function statusCommand(
  effortId: string | undefined,
  root: string,
  write: (text: string) => void,
  fail: (text: string) => void,
  deps: ManagerCommandDeps,
): Promise<number> {
  const effort = effortId ? await readEffort(root, effortId) : await latestEffort(root);
  if (!effort) {
    if (effortId) {
      fail(`[manager] no effort ${effortId} in this portfolio\n`);
      return 1;
    }
    write(`${renderEmptyPortfolioBrief()}\n`);
    return 0;
  }
  // When a GH context is available and a dispatch has been recorded, reconcile
  // the execution artifact state from the tracker as untrusted evidence.
  if (deps.gh && effort.dispatch_issue != null) {
    const ctx = { repo: deps.gh.repo, cwd: deps.gh.cwd, exec: deps.gh.exec };
    const execution = await readExecutionArtifact(ctx, effort.dispatch_issue);
    const derived = computeDerivedState(null, [], execution);
    write(`${renderEffortBriefWithDerived(effort, derived)}\n`);
    return 0;
  }
  write(`${renderEffortBrief(effort)}\n`);
  return 0;
}

async function resumeCommand(
  effortId: string | undefined,
  root: string,
  write: (text: string) => void,
  fail: (text: string) => void,
  deps: ManagerCommandDeps,
): Promise<number> {
  const effort = await resolveEffort(effortId, root, fail);
  if (!effort) return 1;
  const { effort: managed } = await manageEffort(root, effort, {
    now: deps.now,
    host: deps.host,
  });
  write(`${renderEffortBrief(managed)}\n`);
  return 0;
}

async function endCommand(
  effortId: string | undefined,
  root: string,
  write: (text: string) => void,
  fail: (text: string) => void,
  deps: ManagerCommandDeps,
): Promise<number> {
  const effort = await resolveEffort(effortId, root, fail);
  if (!effort) return 1;
  const completed = await endEffort(root, effort, { now: deps.now });
  write(`${renderEffortBrief(completed)}\n`);
  return 0;
}

async function dispatchCommand(
  effortId: string | undefined,
  root: string,
  write: (text: string) => void,
  fail: (text: string) => void,
  deps: ManagerCommandDeps,
): Promise<number> {
  if (!deps.gh) {
    fail("[manager] dispatch requires a GitHub context (--repo and --cwd)\n");
    return 1;
  }
  const effort = await resolveEffort(effortId, root, fail);
  if (!effort) return 1;
  if (effort.dispatch_issue != null) {
    fail(
      `[manager] effort ${effort.effort_id} already dispatched as #${effort.dispatch_issue}\n`,
    );
    return 1;
  }
  const ctx = { repo: deps.gh.repo, cwd: deps.gh.cwd, exec: deps.gh.exec };
  const issueNumber = await dispatchExecutionIssue(ctx, effort, null);
  const dispatched = await saveEffort(
    root,
    { ...effort, dispatch_issue: issueNumber },
    { now: deps.now },
  );
  // Immediately reconcile the new issue's state as untrusted evidence.
  const execution = await readExecutionArtifact(ctx, issueNumber);
  const derived = computeDerivedState(null, [], execution);
  write(`${renderEffortBriefWithDerived(dispatched, derived)}\n`);
  return 0;
}

export async function managerCommand(
  args: readonly string[],
  deps: ManagerCommandDeps = {},
): Promise<number> {
  const write = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const fail = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const words = args.filter((arg) => arg.trim() !== "");
  if (words.length === 0 || words[0] === "--help" || words[0] === "-h") {
    const empty = words.length === 0;
    (empty ? fail : write)(`${USAGE}\n`);
    return empty ? 2 : 0;
  }
  const root = resolveRoot(deps);
  try {
    if (words[0] === "status") return await statusCommand(words[1], root, write, fail, deps);
    if (words[0] === "resume") return await resumeCommand(words[1], root, write, fail, deps);
    if (words[0] === "end") return await endCommand(words[1], root, write, fail, deps);
    if (words[0] === "dispatch") return await dispatchCommand(words[1], root, write, fail, deps);
    // Anything that is not a known lifecycle keyword is the intent.
    if (LIFECYCLE_WORDS.has(words[0])) {
      fail(`[manager] unknown subcommand "${words[0]}"\n`);
      return 1;
    }
    const effort = await startEffort({ root, intent: words.join(" "), now: deps.now });
    write(`${renderEffortBrief(effort)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ManagerStoreError) {
      fail(`[manager] ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
