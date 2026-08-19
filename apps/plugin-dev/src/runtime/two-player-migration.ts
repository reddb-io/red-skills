// runtime/two-player-migration.ts — the real-fs/real-process executor behind the
// ADR 0130 Amendment 4 migration (core/two-player-migration.ts owns the pure plan
// and every rule it encodes).
//
// Run-once through a STAMP, idempotent by construction: the report the migration
// writes to `.red/state/castle/two-player.toon` is also its gate, so a second run
// reads the stamp and returns `already-migrated` having touched nothing.
//
// Best-effort throughout, like the two boot migrations it follows: a launch must
// never fail because a stop, a re-adoption or a registration was refused. A
// refused move is NAMED in the report's `failed` list rather than silently
// dropped, because the operator's next move — and the way back, which the report
// carries — depends on knowing which Worker the host did not take.
import { readFile, readdir, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  afkStateDir,
  goWorkersDir,
  scoutWorkersDir,
  tmpDir,
  workersDir,
} from "@reddb-io/shared/red-paths.js";
import { encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import {
  buildTwoPlayerReport,
  planTwoPlayerMigration,
  resolveTwoPlayerActive,
  summarizeTwoPlayerMigration,
  type TwoPlayerObservation,
  type TwoPlayerPlan,
  type TwoPlayerReport,
  type TwoPlayerWorkerObservation,
} from "../core/two-player-migration.js";
import { isLivePid as defaultIsLivePid, killTreeAndWait } from "./kill-tree.js";
import { resolveProjectLabel } from "./redskilled-birth.js";

/** Where the one-time report is stamped; its presence is the run-once gate. */
export function twoPlayerReportPath(root: string): string {
  return join(afkStateDir(root), "two-player.toon");
}

/** Every side effect the migration performs, injected so tests need no host. */
export interface TwoPlayerMigrationDeps {
  isLivePid(pid: number): boolean;
  /** SIGTERM → grace → SIGKILL, confirming the tree is gone. */
  stopTree(pid: number): Promise<boolean>;
  /** The one opaque string the daemon keys this project by. */
  projectLabel(root: string): string;
  /** Workers the daemon already holds, as `worker id → project label`. */
  hostWorkers(): Promise<ReadonlyMap<string, string>>;
  /** Whether the daemon already holds a registration for this project. */
  isRegistered(projectLabel: string): Promise<boolean>;
  /**
   * Ask the host to hold a live Worker under this project's label.
   *
   * The default is the daemon's own unit sweep, which needs no help: a Worker
   * that is an active unit is re-attached when the daemon next reads the host,
   * so re-adoption here is a CONFIRMATION that host state carries it, not a
   * second adoption mechanism competing with `redskilled/reattach.ts`.
   */
  readopt(workerId: string, projectLabel: string): Promise<boolean>;
  now(): Date;
  /** Where the one-line summary goes. Never silent, never fatal. */
  notice(message: string): void;
}

export interface MigrateToTwoPlayerOptions {
  /**
   * Whether this launch registers instead of starting a per-project runtime. The
   * caller that owns registration passes it; absent, `RED_TWO_PLAYER_CUTOVER`
   * decides, and the default is off — an undeclared era must never stop a healthy
   * per-project runtime.
   */
  active?: boolean;
  env?: Record<string, string | undefined>;
  deps?: Partial<TwoPlayerMigrationDeps>;
}

export type TwoPlayerStatus = "migrated" | "already-migrated" | "inactive";

export interface TwoPlayerResult {
  status: TwoPlayerStatus;
  plan: TwoPlayerPlan;
  report: TwoPlayerReport | null;
  reportPath: string;
}

const EMPTY_PLAN: TwoPlayerPlan = { actions: [], kept: [] };

function defaultDeps(): TwoPlayerMigrationDeps {
  return {
    isLivePid: defaultIsLivePid,
    stopTree: (pid) => killTreeAndWait(pid),
    projectLabel: (root) => resolveProjectLabel(root),
    hostWorkers: async () => new Map<string, string>(),
    isRegistered: async () => false,
    // A Worker that is an active unit is the daemon's to re-attach to, so the
    // default confirms rather than adopts: the host either already carries it —
    // in which case the plan never asked — or it will on its next sweep.
    readopt: async () => true,
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

/** The live pid of this project's own runtime, when it still has one. */
async function readProjectRuntimePid(root: string): Promise<number | null> {
  const lane = join(tmpDir(root), "supervisors", "default");
  let entries: string[] = [];
  try {
    entries = await readdir(lane);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    const pid = await readWorkerPid(join(lane, entry));
    if (pid !== null) return pid;
  }
  return null;
}

/** Every Worker workspace on disk, across all still-readable worker lanes. */
async function observeWorkers(
  root: string,
  deps: TwoPlayerMigrationDeps,
): Promise<TwoPlayerWorkerObservation[]> {
  const held = await deps.hostWorkers().catch(() => new Map<string, string>());
  const observed: TwoPlayerWorkerObservation[] = [];
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
      observed.push({
        workerId,
        issue: await readClaimedIssue(workspace),
        pid,
        live: pid !== null && deps.isLivePid(pid),
        workspace,
        heldByHost: held.has(workerId),
      });
    }
  }
  return observed;
}

/** Gather the machine's pre-migration state. Read-only; decides nothing. */
export async function observeTwoPlayerMigration(
  root: string,
  deps: TwoPlayerMigrationDeps,
): Promise<TwoPlayerObservation> {
  const projectLabel = deps.projectLabel(root);
  const pid = await readProjectRuntimePid(root).catch(() => null);
  return {
    projectLabel,
    runtime: pid === null ? null : { pid, live: deps.isLivePid(pid) },
    workers: await observeWorkers(root, deps),
    registered: await deps.isRegistered(projectLabel).catch(() => false),
  };
}

async function writeReport(path: string, report: TwoPlayerReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${encodeDevSnapshotToon(report as unknown as never)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Carry one project's live pre-migration state into the two-player model, once.
 *
 * Returns `inactive` when this launch is not yet the two-player era,
 * `already-migrated` when the stamp is present, and `migrated` — with the full
 * report — the single time it actually moves anything. Never throws.
 */
export async function migrateToTwoPlayer(
  root: string,
  options: MigrateToTwoPlayerOptions = {},
): Promise<TwoPlayerResult> {
  const reportPath = twoPlayerReportPath(root);
  const deps: TwoPlayerMigrationDeps = { ...defaultDeps(), ...options.deps };
  const env = options.env ?? process.env;

  if (!resolveTwoPlayerActive(env, options.active)) {
    return { status: "inactive", plan: EMPTY_PLAN, report: null, reportPath };
  }
  if (existsSync(reportPath)) {
    return { status: "already-migrated", plan: EMPTY_PLAN, report: null, reportPath };
  }

  const observation = await observeTwoPlayerMigration(root, deps);
  const plan = planTwoPlayerMigration(observation);

  const stopped: string[] = [];
  const readopted: string[] = [];
  const failed: string[] = [];

  for (const action of plan.actions) {
    let ok = false;
    try {
      if (action.kind === "stop-runtime") {
        ok = (await deps.stopTree(action.pid as number)) !== false;
        if (ok) stopped.push(action.subject);
      } else {
        // Never a stop: the Worker outlives the runtime that asked for it, and
        // this move only asks the host to hold it under a named project.
        ok = (await deps.readopt(action.workerId as string, action.projectLabel as string)) !== false;
        if (ok) readopted.push(action.subject);
      }
    } catch {
      ok = false;
    }
    if (!ok) failed.push(action.subject);
  }

  const report = buildTwoPlayerReport(plan, { stopped, readopted, failed }, deps.now().toISOString());
  try {
    await writeReport(reportPath, report);
  } catch {
    // A report that could not be stamped leaves the migration to the next launch,
    // which is the safe direction: every move it makes is idempotent on its own,
    // and skipping the migration entirely would leave the removed player running.
  }
  deps.notice(summarizeTwoPlayerMigration(plan));
  return { status: "migrated", plan, report, reportPath };
}

export { TWO_PLAYER_CONTRACT, TWO_PLAYER_RECOVERY_DOC } from "../core/two-player-migration.js";
