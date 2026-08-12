import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  LANE_RETENTION_REGISTRY,
  LIVE_WORKER_LOG_WARNING_THRESHOLD_BYTES,
  laneTempOwnerPid,
  type LaneRetentionPolicy,
} from "@reddb-io/shared/lane-retention.js";
import {
  castleStateDir,
  deathAttributionFile,
  deathAttributionFileIn,
  deathLaneFile,
  deathLaneFileIn,
  rspStateDir,
  stateDir,
  tmpDir,
} from "@reddb-io/shared/red-paths.js";
import { REDSKILLED_EVENT_LANE_FILE } from "@reddb-io/redskilled/event-lane";
import type {
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeResult,
} from "./types.js";

export const LANE_CENSUS_PROBE_ID = "runtime.lane-census";
export const LANE_CENSUS_PROBE_NAME = "Runtime lane census";
export const LANE_CENSUS_CANONICAL_FIX =
  "Repair the owning lane writer: enforce its declared ceiling, register intentional TOONL lanes, and let the owner sweep dead-pid replacement temps.";

/** Explicit census side of the writer-policy parity invariant. */
export const LANE_CENSUS_POLICY_NAMES = [
  "process-deaths",
  "github-spend",
  "castle-singleton-events",
  "rsp-telemetry-spool",
  "rsp-telemetry-legacy-spool",
  "rsp-telemetry-corrections",
  "death-attributions",
  "worker-log",
  "supervisor-log",
  "monitor-log",
  "worker-liveness",
  "castle-history",
  "redskilled-events",
] as const;

export type LaneCensusTier = "project" | "host";

export interface LaneCensusLane {
  readonly id: string;
  readonly tier: LaneCensusTier;
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
  readonly maxBytes?: number;
  readonly maxLines?: number;
}

export interface LaneCensusTemp {
  readonly path: string;
  readonly pid: number;
  readonly pidAlive: boolean;
}

export interface LaneCensusLiveLog {
  readonly path: string;
  readonly bytes: number;
  readonly warnBytes: number;
}

export interface LaneCensusProbeInput {
  readonly lanes: readonly LaneCensusLane[];
  readonly unregisteredToonl: readonly string[];
  readonly temps: readonly LaneCensusTemp[];
  /** Live Workers' logs over the warning threshold — detection only (#3644). */
  readonly liveLogs?: readonly LaneCensusLiveLog[];
}

export interface CollectLaneCensusOptions {
  readonly projectRoot: string;
  /** The already-resolved daemon home, injected to keep private paths out of results. */
  readonly hostRoot: string;
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  /** Stat seam for the live-log size read; defaults to fs stat. */
  readonly readStat?: (
    path: string,
  ) => Promise<{ size: number }> | { size: number };
}

interface LaneRegistration {
  readonly id: string;
  readonly tier: LaneCensusTier;
  readonly absolutePath: string;
  readonly path: string;
  readonly policy: LaneRetentionPolicy;
}

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function projectDisplay(projectRoot: string, path: string): string {
  return slash(relative(projectRoot, path));
}

function hostDisplay(hostRoot: string, path: string): string {
  return `[host]/${slash(relative(hostRoot, path))}`;
}

function pathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeDisplay(
  projectRoot: string,
  hostRoot: string,
  path: string,
): string {
  return pathInside(projectRoot, path)
    ? projectDisplay(projectRoot, path)
    : hostDisplay(hostRoot, path);
}

function registration(
  id: string,
  tier: LaneCensusTier,
  absolutePath: string,
  path: string,
  policy: LaneRetentionPolicy,
): LaneRegistration {
  return { id, tier, absolutePath, path, policy };
}

function staticRegistrations(
  projectRoot: string,
  hostRoot: string,
): LaneRegistration[] {
  const projectState = stateDir(projectRoot);
  const hostState = join(hostRoot, "state");
  const project = (id: string, path: string, policy: LaneRetentionPolicy) =>
    registration(
      id,
      "project",
      path,
      projectDisplay(projectRoot, path),
      policy,
    );
  const host = (id: string, path: string, policy: LaneRetentionPolicy) =>
    registration(id, "host", path, hostDisplay(hostRoot, path), policy);
  return [
    project(
      "process-deaths",
      deathLaneFile(projectRoot),
      LANE_RETENTION_REGISTRY["process-deaths"],
    ),
    project(
      "death-attributions",
      deathAttributionFile(projectRoot),
      LANE_RETENTION_REGISTRY["death-attributions"],
    ),
    project(
      "github-spend",
      join(projectState, "github", "spend.toonl"),
      LANE_RETENTION_REGISTRY["github-spend"],
    ),
    project(
      "github-spend",
      join(rspStateDir(projectRoot), "github", "spend.toonl"),
      LANE_RETENTION_REGISTRY["github-spend"],
    ),
    project(
      "castle-singleton-events",
      join(castleStateDir(projectRoot), "singleton-events.toonl"),
      LANE_RETENTION_REGISTRY["castle-singleton-events"],
    ),
    project(
      "castle-history",
      join(castleStateDir(projectRoot), "history.toonl"),
      LANE_RETENTION_REGISTRY["castle-history"],
    ),
    project(
      "rsp-telemetry-spool",
      join(rspStateDir(projectRoot), "rsp-telemetry.spool.toonl"),
      LANE_RETENTION_REGISTRY["rsp-telemetry-spool"],
    ),
    project(
      "rsp-telemetry-legacy-spool",
      join(rspStateDir(projectRoot), "rsp-telemetry.spool.jsonl"),
      LANE_RETENTION_REGISTRY["rsp-telemetry-legacy-spool"],
    ),
    project(
      "rsp-telemetry-corrections",
      join(rspStateDir(projectRoot), "rsp-telemetry.spool.corrections.toonl"),
      LANE_RETENTION_REGISTRY["rsp-telemetry-corrections"],
    ),
    host(
      "redskilled-events",
      join(hostRoot, REDSKILLED_EVENT_LANE_FILE),
      LANE_RETENTION_REGISTRY["redskilled-events"],
    ),
    host(
      "process-deaths",
      deathLaneFileIn(hostState),
      LANE_RETENTION_REGISTRY["process-deaths"],
    ),
    host(
      "death-attributions",
      deathAttributionFileIn(hostState),
      LANE_RETENTION_REGISTRY["death-attributions"],
    ),
    host(
      "github-spend",
      join(hostState, "github", "spend.toonl"),
      LANE_RETENTION_REGISTRY["github-spend"],
    ),
  ];
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function walkFiles(root: string, recursive = true): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile()) files.push(path);
    else if (recursive && entry.isDirectory())
      files.push(...(await walkFiles(path)));
  }
  return files;
}

async function countLines(path: string, bytes: number): Promise<number> {
  if (bytes === 0) return 0;
  return new Promise<number>((resolve, reject) => {
    let lines = 0;
    let lastByte = -1;
    let firstLine = "";
    let firstLineComplete = false;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const byte of buffer) {
        if (byte === 10) {
          lines += 1;
          firstLineComplete = true;
        } else if (!firstLineComplete && firstLine.length < 4_096) {
          firstLine += String.fromCharCode(byte);
        }
      }
      if (buffer.length > 0) lastByte = buffer[buffer.length - 1]!;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const physicalLines = lines + (lastByte === 10 ? 0 : 1);
      const toonlHeader = /^\[\d*\]\{.*\}:$/.test(firstLine);
      resolve(physicalLines - (toonlHeader ? 1 : 0));
    });
  });
}

async function inspectLane(lane: LaneRegistration): Promise<LaneCensusLane> {
  let bytes = 0;
  try {
    bytes = (await stat(lane.absolutePath)).size;
  } catch (error) {
    if (!absent(error)) throw error;
  }
  return {
    id: lane.id,
    tier: lane.tier,
    path: lane.path,
    bytes,
    lines: await countLines(lane.absolutePath, bytes),
    ...(lane.policy.maxBytes === undefined
      ? {}
      : { maxBytes: lane.policy.maxBytes }),
    ...(lane.policy.maxLines === undefined
      ? {}
      : { maxLines: lane.policy.maxLines }),
  };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Collects bounded lane usage without mutating either project or host state. */
export async function collectLaneCensusProbeInput(
  options: CollectLaneCensusOptions,
): Promise<LaneCensusProbeInput> {
  const { projectRoot, hostRoot } = options;
  const workersRoot = join(tmpDir(projectRoot), "workers");
  const supervisorsRoot = join(tmpDir(projectRoot), "supervisors");
  const monitorsRoot = join(tmpDir(projectRoot), "monitors");
  const [
    projectStateFiles,
    workerFiles,
    supervisorFiles,
    monitorFiles,
    hostRootFiles,
    hostStateFiles,
  ] = await Promise.all([
    walkFiles(stateDir(projectRoot)),
    walkFiles(workersRoot),
    walkFiles(supervisorsRoot),
    walkFiles(monitorsRoot),
    walkFiles(hostRoot, false),
    walkFiles(join(hostRoot, "state")),
  ]);
  const registrations = staticRegistrations(projectRoot, hostRoot);
  for (const absolutePath of workerFiles) {
    const segments = slash(relative(workersRoot, absolutePath)).split("/");
    if (segments.length !== 2) continue;
    const lane =
      segments[1] === "worker.log.toonl"
        ? { id: "worker-log", policy: LANE_RETENTION_REGISTRY["worker-log"] }
        : segments[1] === "liveness.toonl"
          ? {
              id: "worker-liveness",
              policy: LANE_RETENTION_REGISTRY["worker-liveness"],
            }
          : undefined;
    if (!lane) continue;
    registrations.push(
      registration(
        lane.id,
        "project",
        absolutePath,
        projectDisplay(projectRoot, absolutePath),
        lane.policy,
      ),
    );
  }
  for (const [root, files, filename, id, policy] of [
    [
      supervisorsRoot,
      supervisorFiles,
      "supervisor.log.toonl",
      "supervisor-log",
      LANE_RETENTION_REGISTRY["supervisor-log"],
    ],
    [
      monitorsRoot,
      monitorFiles,
      "monitor.log.toonl",
      "monitor-log",
      LANE_RETENTION_REGISTRY["monitor-log"],
    ],
  ] as const) {
    for (const absolutePath of files) {
      const segments = slash(relative(root, absolutePath)).split("/");
      if (segments.length !== 2 || segments[1] !== filename) continue;
      registrations.push(
        registration(
          id,
          "project",
          absolutePath,
          projectDisplay(projectRoot, absolutePath),
          policy,
        ),
      );
    }
  }

  const registeredPaths = new Set(
    registrations.map((lane) => lane.absolutePath),
  );
  const discoveredFiles = [
    ...projectStateFiles,
    ...workerFiles,
    ...supervisorFiles,
    ...monitorFiles,
    ...hostRootFiles,
    ...hostStateFiles,
  ];
  const unregisteredToonl = discoveredFiles
    .filter((path) => path.endsWith(".toonl") && !registeredPaths.has(path))
    .map((path) => safeDisplay(projectRoot, hostRoot, path))
    .sort();

  const isPidAlive = options.isPidAlive ?? defaultPidAlive;
  const temps: LaneCensusTemp[] = [];
  for (const path of discoveredFiles) {
    const pid = laneTempOwnerPid(path);
    if (pid === null) continue;
    temps.push({
      path: safeDisplay(projectRoot, hostRoot, path),
      pid,
      pidAlive: await isPidAlive(pid),
    });
  }

  const readStat = options.readStat ?? stat;
  const liveLogs: LaneCensusLiveLog[] = [];
  for (const absolutePath of workerFiles) {
    const segments = slash(relative(workersRoot, absolutePath)).split("/");
    if (segments.length !== 2 || segments[1] !== "worker.log.toonl") continue;
    const pidPath = join(workersRoot, segments[0]!, "worker.pid");
    if (!workerFiles.includes(pidPath)) continue;
    const pid = Number(
      (await readFile(pidPath, "utf8").catch(() => "")).trim(),
    );
    if (!Number.isInteger(pid) || pid <= 0 || !(await isPidAlive(pid)))
      continue;
    const size = (await readStat(absolutePath)).size;
    if (size <= LIVE_WORKER_LOG_WARNING_THRESHOLD_BYTES) continue;
    liveLogs.push({
      path: projectDisplay(projectRoot, absolutePath),
      bytes: size,
      warnBytes: LIVE_WORKER_LOG_WARNING_THRESHOLD_BYTES,
    });
  }

  return {
    lanes: (await Promise.all(registrations.map(inspectLane))).sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    unregisteredToonl,
    temps: temps.sort((a, b) => a.path.localeCompare(b.path)),
    liveLogs: liveLogs.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function laneOverCeiling(lane: LaneCensusLane): boolean {
  return (
    (lane.maxBytes !== undefined && lane.bytes > lane.maxBytes) ||
    (lane.maxLines !== undefined && lane.lines > lane.maxLines)
  );
}

function laneEvidence(lane: LaneCensusLane): string {
  const ceilings = [
    lane.maxBytes === undefined
      ? `${lane.bytes} bytes`
      : `${lane.bytes}/${lane.maxBytes} bytes`,
    lane.maxLines === undefined
      ? `${lane.lines} lines`
      : `${lane.lines}/${lane.maxLines} lines`,
  ];
  return `${lane.id}(${lane.tier})=${ceilings.join(", ")}${laneOverCeiling(lane) ? " [over]" : ""}`;
}

export function runLaneCensusProbe(
  input: LaneCensusProbeInput | undefined,
): OperationalProbeResult {
  if (!input) {
    return {
      id: LANE_CENSUS_PROBE_ID,
      name: LANE_CENSUS_PROBE_NAME,
      verdict: "ok",
      evidence: "lane census not configured",
      canonicalFix: LANE_CENSUS_CANONICAL_FIX,
    };
  }

  const over = input.lanes.filter(laneOverCeiling);
  const deadTemps = input.temps.filter((temp) => !temp.pidAlive);
  const liveLogs = input.liveLogs ?? [];
  const red =
    over.length > 0 ||
    input.unregisteredToonl.length > 0 ||
    deadTemps.length > 0 ||
    liveLogs.length > 0;
  const details = input.lanes.map(laneEvidence);
  for (const log of liveLogs) {
    details.push(
      `live-log=${log.path} ${log.bytes}/${log.warnBytes} bytes [over]`,
    );
  }
  if (input.unregisteredToonl.length > 0) {
    details.push(`unregistered=${input.unregisteredToonl.join(",")}`);
  }
  if (deadTemps.length > 0) {
    details.push(
      `dead-pid-temps=${deadTemps.map((temp) => `${temp.path}(pid=${temp.pid})`).join(",")}`,
    );
  }

  return {
    id: LANE_CENSUS_PROBE_ID,
    name: LANE_CENSUS_PROBE_NAME,
    verdict: red ? "red" : "ok",
    evidence: details.join("; "),
    canonicalFix: LANE_CENSUS_CANONICAL_FIX,
    data: input,
  };
}

export const laneCensusProbe: OperationalProbe = {
  id: LANE_CENSUS_PROBE_ID,
  name: LANE_CENSUS_PROBE_NAME,
  canonicalFix: LANE_CENSUS_CANONICAL_FIX,
  run: (context: OperationalProbeContext) =>
    runLaneCensusProbe(context.laneCensus),
};
