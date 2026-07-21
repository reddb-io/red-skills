// commands/manager.ts — the operator front door of the Manager (Spec #2290,
// slice #2291; architecture in ADR 0109).
//
// Two shapes, matching the walking skeleton's acceptance:
//   `manager <intent>`  — mint an effort from the intent and persist it.
//   `manager status [id]` — render the brief for one effort (the most recently
//                           started one by default) from OWNED state.
//
// The command is conversation-first, not a subcommand tree: anything that is
// not a lifecycle operation IS the intent. Routing, dispatch, and reconciliation
// are later slices — this one only proves an effort survives the session.

import { homedir } from "node:os";
import { resolveManagerRoot } from "@reddb-io/shared/red-paths.js";
import { renderEffortBrief, renderEmptyPortfolioBrief } from "../core/manager/brief.js";
import {
  ManagerStoreError,
  latestEffort,
  readEffort,
  startEffort,
} from "../core/manager/effort-store.js";

export interface ManagerCommandDeps {
  /** The directory that CONTAINS `.red/manager`; defaults to the operator home. */
  root?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
}

const USAGE = [
  "usage: afk manager <intent>          start an effort from an intent",
  "       afk manager status [effort]   render an effort brief (default: the newest)",
].join("\n");

function resolveRoot(deps: ManagerCommandDeps): string {
  return deps.root ?? resolveManagerRoot({ homeDir: homedir(), env: process.env });
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
