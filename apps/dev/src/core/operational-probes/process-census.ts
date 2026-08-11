import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";
import { readRedskilledEvents, rehydrateWorkers } from "@reddb-io/redskilled/event-lane";
import {
  censusRedskilledProcesses,
  selectRedskilledProcessCensus,
  type RedskilledProcessCensusRow,
  type SelectRedskilledProcessCensusInput,
} from "@reddb-io/redskilled/orphan-reaper";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { isRedskilledHostState } from "@reddb-io/redskilled/host-state";
import { sendRedskilledRequest } from "@reddb-io/redskilled/protocol";
import { listActiveWorkerUnits } from "@reddb-io/redskilled/reattach";
import type {
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeResult,
} from "./types.js";

export const PROCESS_CENSUS_PROBE_ID = "runtime.process-census";
export const PROCESS_CENSUS_PROBE_NAME = "Runtime process census";
export const PROCESS_CENSUS_CANONICAL_FIX =
  `Inspect the detection-only census with ${canonicalInvocation("red-skills-redskilled", ["reap", "--report"])}; ` +
  "the daemon reaps only stamped orphans, while unstamped suspects and dump files require operator review.";

export type ProcessCensusProbeInput = SelectRedskilledProcessCensusInput;

export interface CollectProcessCensusOptions {
  readonly projectRoot: string;
  readonly processes?: () => readonly RedskilledProcessCensusRow[] | Promise<readonly RedskilledProcessCensusRow[]>;
  readonly activeWorkerUnits?: () => readonly string[] | Promise<readonly string[]>;
  readonly heldWorkerIds?: () => Iterable<string> | Promise<Iterable<string>>;
  readonly liveBirthIds?: () => Iterable<string> | Promise<Iterable<string>>;
}

const DUMP_FILE = /^(?:core(?:\.\d+)?|.+\.core)$/i;

async function walkDumpFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && DUMP_FILE.test(entry.name)) files.push(path);
    else if (entry.isDirectory()) files.push(...await walkDumpFiles(path));
  }
  return files;
}

async function daemonHeldWorkerIds(): Promise<readonly string[]> {
  const paths = resolveRedskilledPaths();
  try {
    const response = await sendRedskilledRequest(
      { socketPath: paths.socketPath, timeoutMs: 500 },
      { id: randomUUID(), op: "host-state" },
    );
    return response.ok && isRedskilledHostState(response.value)
      ? response.value.workers.map((worker) => worker.worker_id)
      : [];
  } catch {
    return [];
  }
}

async function liveBirthWorkerIds(): Promise<readonly string[]> {
  const paths = resolveRedskilledPaths();
  try {
    return rehydrateWorkers(await readRedskilledEvents(paths.eventLanePath))
      .map((worker) => worker.worker_id);
  } catch {
    return [];
  }
}

/** Collect the project/host process facts without adoption, signalling or deletion. */
export async function collectProcessCensusProbeInput(
  options: CollectProcessCensusOptions,
): Promise<ProcessCensusProbeInput> {
  const workerRoots = ["workers", "go-workers", "scout-workers"]
    .map((lane) => join(options.projectRoot, ".red", "tmp", lane));
  const [processes, activeWorkerUnits, heldWorkerIds, liveBirthIds, dumpFiles] = await Promise.all([
    Promise.resolve(options.processes?.() ?? censusRedskilledProcesses()).catch(() => []),
    Promise.resolve(options.activeWorkerUnits?.() ?? listActiveWorkerUnits()).catch(() => []),
    Promise.resolve(options.heldWorkerIds?.() ?? daemonHeldWorkerIds()).catch(() => []),
    Promise.resolve(options.liveBirthIds?.() ?? liveBirthWorkerIds()).catch(() => []),
    Promise.all(workerRoots.map(walkDumpFiles)).then((rows) => rows.flat()),
  ]);
  return {
    processes,
    active_worker_units: activeWorkerUnits,
    held_worker_ids: new Set(heldWorkerIds),
    live_birth_ids: new Set(liveBirthIds),
    dump_files: dumpFiles.sort(),
  };
}

export function runProcessCensusProbe(input: ProcessCensusProbeInput | undefined): OperationalProbeResult {
  if (!input) {
    return {
      id: PROCESS_CENSUS_PROBE_ID,
      name: PROCESS_CENSUS_PROBE_NAME,
      verdict: "ok",
      evidence: "process census not configured",
      canonicalFix: PROCESS_CENSUS_CANONICAL_FIX,
    };
  }
  const { census } = selectRedskilledProcessCensus(input);
  const red = census.stamped_orphans > 0 || census.unstamped_suspects > 0 || census.dump_files > 0;
  return {
    id: PROCESS_CENSUS_PROBE_ID,
    name: PROCESS_CENSUS_PROBE_NAME,
    verdict: red ? "red" : "ok",
    evidence: [
      `active-worker-units=${census.active_worker_units}`,
      `daemon-held-workers=${census.daemon_held_workers}`,
      `stamped-orphans=${census.stamped_orphans}`,
      `unstamped-suspects=${census.unstamped_suspects}`,
      `dump-files=${census.dump_files}`,
    ].join("; "),
    canonicalFix: PROCESS_CENSUS_CANONICAL_FIX,
    data: census,
  };
}

export const processCensusProbe: OperationalProbe = {
  id: PROCESS_CENSUS_PROBE_ID,
  name: PROCESS_CENSUS_PROBE_NAME,
  canonicalFix: PROCESS_CENSUS_CANONICAL_FIX,
  run: (context: OperationalProbeContext) => runProcessCensusProbe(context.processCensus),
};
