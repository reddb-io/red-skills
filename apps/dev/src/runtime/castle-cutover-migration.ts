// runtime/castle-cutover-migration.ts — the real-fs/real-process executor behind
// the ADR 0130 cutover migration (core/castle-cutover-migration.ts owns the pure
// plan and every rule it encodes).
//
// Run-once through a STAMP, idempotent by construction: the report the migration
// writes to `.red/state/castle/cutover.toon` is also its gate, so a second boot
// reads the stamp and returns `already-migrated` having touched nothing. The
// stamp — not a live probe — is what protects a Worker born AFTER the cutover
// from being mistaken for one born before it.
//
// Best-effort throughout, like the ADR 0105 boot migration it follows: a launch
// must never fail because a stop or a prune was refused. A refused action is
// NAMED in the report's `failed` list rather than silently dropped, because the
// operator's next move depends on knowing which Worker survived the cutover.
import { readFile, readdir, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afkStateDir, goWorkersDir, scoutWorkersDir, tmpDir, workersDir } from "@reddb-io/shared/red-paths.js";
import { encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import {
  buildCastleCutoverReport,
  planCastleCutover,
  resolveCutoverActive,
  summarizeCastleCutover,
  type CastleCutoverObservation,
  type CastleCutoverPlan,
  type CastleCutoverReport,
  type CutoverWorkerObservation,
  type CutoverWorktreeObservation,
} from "../core/castle-cutover-migration.js";
import { isLivePid as defaultIsLivePid, killTreeAndWait } from "./kill-tree.js";
import { discoverLiveSupervisorPid } from "./supervisor-state.js";
import { execTool } from "./exec.js";

/** Where the one-time report is stamped; its presence is the run-once gate. */
export function castleCutoverReportPath(root: string): string {
  return join(afkStateDir(root), "cutover.toon");
}

/** Every side effect the migration performs, injected so tests need no host. */
export interface CastleCutoverDeps {
  isLivePid(pid: number): boolean;
  /** SIGTERM → grace → SIGKILL, confirming the tree is gone. */
  stopTree(pid: number): Promise<boolean>;
  /** Registered git worktree paths, primary checkout excluded. */
  listWorktrees(): Promise<string[]>;
  /** Drop registrations whose directories are gone. */
  pruneWorktrees(): Promise<boolean>;
  /**
   * Unit names the daemon placed Workers in, keyed by worker id. Empty by
   * default: a caller that can reach the daemon supplies it, and a caller that
   * cannot relies on the stamp, which is the stronger gate anyway.
   */
  workerUnits(): Promise<ReadonlyMap<string, string>>;
  now(): Date;
  /** Where the one-line summary goes. Never silent, never fatal. */
  notice(message: string): void;
}

export interface MigrateCastleCutoverOptions {
  /**
   * Whether Workers are born through the daemon on this launch. The caller that
   * owns birth passes it; absent, `RED_CASTLE_CUTOVER` decides, and the default
   * is off — an inactive cutover must never quiesce a healthy classic fleet.
   */
  cutoverActive?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<CastleCutoverDeps>;
}

export type CastleCutoverStatus = "migrated" | "already-migrated" | "inactive";

export interface CastleCutoverResult {
  status: CastleCutoverStatus;
  plan: CastleCutoverPlan;
  report: CastleCutoverReport | null;
  reportPath: string;
}

const EMPTY_PLAN: CastleCutoverPlan = { actions: [], kept: [] };

function defaultDeps(root: string): CastleCutoverDeps {
  return {
    isLivePid: defaultIsLivePid,
    stopTree: (pid) => killTreeAndWait(pid),
    listWorktrees: async () => {
      const out = await execTool("git", ["worktree", "list", "--porcelain"], { cwd: root });
      if (out.code !== 0) return [];
      const paths = out.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
        .filter((path) => path !== "");
      // The first entry is the primary checkout; it is never a migration subject.
      return paths.slice(1);
    },
    pruneWorktrees: async () => {
      const out = await execTool("git", ["worktree", "prune"], { cwd: root });
      return out.code === 0;
    },
    workerUnits: async () => new Map<string, string>(),
    now: () => new Date(),
    notice: (message) => {
      try {
        process.stderr.write(`${message}\n`);
      } catch {
        // a closed stderr never blocks a launch
      }
    },
  };
}

async function readWorkerPid(pidFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readClaimedIssue(workspace: string): Promise<number | null> {
  let entries: string[] = [];
  try {
    entries = await readdir(workspace);
  } catch {
    return null;
  }
  const issues = entries
    .map((entry) => /^([1-9][0-9]*)$/.exec(entry)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  return issues.length > 0 ? (issues[0] as number) : null;
}

/** Every Worker workspace on disk, across all still-readable worker lanes. */
async function observeWorkers(
  root: string,
  deps: CastleCutoverDeps,
): Promise<CutoverWorkerObservation[]> {
  const units = await deps.workerUnits().catch(() => new Map<string, string>());
  const observed: CutoverWorkerObservation[] = [];
  for (const lane of [workersDir(root), goWorkersDir(root), scoutWorkersDir(root)]) {
    let ids: string[] = [];
    try {
      ids = await readdir(lane);
    } catch {
      continue;
    }
    for (const workerId of ids) {
      if (!/^[A-Za-z0-9_-]+$/.test(workerId)) continue;
      const workspace = join(lane, workerId);
      const pid = await readWorkerPid(join(workspace, "worker.pid"));
      const unit = units.get(workerId);
      observed.push({
        workerId,
        issue: await readClaimedIssue(workspace),
        pid,
        live: pid !== null && deps.isLivePid(pid),
        workspace,
        ...(unit !== undefined ? { unit } : {}),
      });
    }
  }
  return observed;
}

async function observeWorktrees(deps: CastleCutoverDeps): Promise<CutoverWorktreeObservation[]> {
  const paths = await deps.listWorktrees().catch(() => [] as string[]);
  return paths.map((path) => ({ path, present: existsSync(path) }));
}

/** Gather the machine's pre-cutover state. Read-only; decides nothing. */
export async function observeCastleCutover(
  root: string,
  deps: CastleCutoverDeps,
): Promise<CastleCutoverObservation> {
  const supervisorDir = join(tmpDir(root), "supervisors", "default");
  const discovery = await discoverLiveSupervisorPid(supervisorDir, deps.isLivePid).catch(() => null);
  return {
    supervisor: discovery === null ? null : { pid: discovery.pid, live: true },
    workers: await observeWorkers(root, deps),
    worktrees: await observeWorktrees(deps),
  };
}

async function writeReport(path: string, report: CastleCutoverReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${encodeDevSnapshotToon(report as unknown as never)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Carry one project's live pre-cutover state across the daemon cutover, once.
 *
 * Returns `inactive` when Workers are not yet born through the daemon,
 * `already-migrated` when the stamp is present, and `migrated` — with the full
 * report — the single time it actually moves anything. Never throws.
 */
export async function migrateCastleCutover(
  root: string,
  options: MigrateCastleCutoverOptions = {},
): Promise<CastleCutoverResult> {
  const reportPath = castleCutoverReportPath(root);
  const deps: CastleCutoverDeps = { ...defaultDeps(root), ...options.deps };
  const env = options.env ?? process.env;

  if (!resolveCutoverActive(env, options.cutoverActive)) {
    return { status: "inactive", plan: EMPTY_PLAN, report: null, reportPath };
  }
  if (existsSync(reportPath)) {
    return { status: "already-migrated", plan: EMPTY_PLAN, report: null, reportPath };
  }

  const observation = await observeCastleCutover(root, deps);
  const plan = planCastleCutover(observation);

  const stopped: string[] = [];
  const quiesced: string[] = [];
  const pruned: string[] = [];
  const failed: string[] = [];

  for (const action of plan.actions) {
    if (action.kind === "stop-supervisor" || action.kind === "quiesce-worker") {
      let ok = false;
      try {
        ok = (await deps.stopTree(action.pid as number)) !== false;
      } catch {
        ok = false;
      }
      if (!ok) failed.push(action.subject);
      else if (action.kind === "stop-supervisor") stopped.push(action.subject);
      else quiesced.push(action.subject);
    }
  }

  const prunable = plan.actions.filter((action) => action.kind === "prune-worktree");
  if (prunable.length > 0) {
    let ok = false;
    try {
      ok = await deps.pruneWorktrees();
    } catch {
      ok = false;
    }
    for (const action of prunable) (ok ? pruned : failed).push(action.subject);
  }

  const report = buildCastleCutoverReport(
    plan,
    { stopped, quiesced, pruned, failed },
    deps.now().toISOString(),
  );
  try {
    await writeReport(reportPath, report);
  } catch {
    // A report that could not be stamped leaves the migration to the next boot,
    // which is the safe direction: quiescing twice costs nothing, skipping the
    // migration entirely would leave unbudgeted Workers alive.
  }
  deps.notice(summarizeCastleCutover(plan));
  return { status: "migrated", plan, report, reportPath };
}

export { CASTLE_CUTOVER_CONTRACT } from "../core/castle-cutover-migration.js";
