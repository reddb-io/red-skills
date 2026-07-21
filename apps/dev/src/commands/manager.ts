// commands/manager.ts — the operator front door of the Manager (Spec #2290,
// slices #2291, #2292, #2293; architecture in ADR 0109).
//
// Lifecycle operations understood by this command:
//   `manager <intent>`              — mint an effort from the intent and persist it.
//   `manager status [id]`           — render the brief for one effort (the most
//                                     recently started one by default).
//   `manager resume [id]`           — transition inbox/paused effort → active, acquire lease.
//   `manager end [id]`              — transition active effort → completed, release lease.
//   `manager route <id> <skill>`    — record the ask-red route for an effort.
//   `manager artifact <id> <ref>`   — capture an artifact reference from an
//                                     inline session-bound skill run.
//
// The command is conversation-first: anything that is not a lifecycle keyword IS
// the intent. Routing classification (intent → skill) is ask-red's job at the
// SKILL.md/agent layer; this command only stores the route that ask-red returned
// and the artifact references that inline skills produce.

import { homedir } from "node:os";
import { resolveManagerRoot } from "@reddb-io/shared/red-paths.js";
import { renderEffortBrief, renderEmptyPortfolioBrief } from "../core/manager/brief.js";
import {
  ManagerStoreError,
  latestEffort,
  readEffort,
  saveEffort,
  startEffort,
} from "../core/manager/effort-store.js";
import { endEffort, manageEffort } from "../core/manager/effort-lease.js";

export interface ManagerCommandDeps {
  /** The directory that CONTAINS `.red/manager`; defaults to the operator home. */
  root?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
  /** Injected host name, so tests can pin it without touching `os.hostname()`. */
  host?: string;
}

const USAGE = [
  "usage: afk manager <intent>                  start an effort from an intent",
  "       afk manager status [effort]           render an effort brief (default: newest)",
  "       afk manager resume [effort]           transition an effort to active and acquire the lease",
  "       afk manager end [effort]              transition an active effort to completed",
  "       afk manager route <effort> <skill>    record the ask-red route",
  "       afk manager artifact <effort> <ref>   capture an artifact reference",
].join("\n");

const LIFECYCLE_WORDS = new Set(["status", "resume", "end", "route", "artifact"]);

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

async function routeCommand(
  effortId: string | undefined,
  skill: string | undefined,
  root: string,
  write: (text: string) => void,
  fail: (text: string) => void,
  now: (() => Date) | undefined,
): Promise<number> {
  if (!effortId || !skill) {
    fail(`${USAGE}\n`);
    return 2;
  }
  const effort = await readEffort(root, effortId);
  if (!effort) {
    fail(`[manager] no effort ${effortId} in this portfolio\n`);
    return 1;
  }
  const updated = await saveEffort(root, { ...effort, route: skill }, { now });
  write(`${renderEffortBrief(updated)}\n`);
  return 0;
}

async function artifactCommand(
  effortId: string | undefined,
  ref: string | undefined,
  root: string,
  write: (text: string) => void,
  fail: (text: string) => void,
  now: (() => Date) | undefined,
): Promise<number> {
  if (!effortId || !ref) {
    fail(`${USAGE}\n`);
    return 2;
  }
  const effort = await readEffort(root, effortId);
  if (!effort) {
    fail(`[manager] no effort ${effortId} in this portfolio\n`);
    return 1;
  }
  const existing = effort.artifact_refs ?? [];
  const updated = await saveEffort(
    root,
    { ...effort, artifact_refs: [...existing, ref] },
    { now },
  );
  write(`${renderEffortBrief(updated)}\n`);
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
    if (words[0] === "status") return await statusCommand(words[1], root, write, fail);
    if (words[0] === "resume") return await resumeCommand(words[1], root, write, fail, deps);
    if (words[0] === "end") return await endCommand(words[1], root, write, fail, deps);
    if (words[0] === "route") {
      return await routeCommand(words[1], words[2], root, write, fail, deps.now);
    }
    if (words[0] === "artifact") {
      return await artifactCommand(words[1], words[2], root, write, fail, deps.now);
    }
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
