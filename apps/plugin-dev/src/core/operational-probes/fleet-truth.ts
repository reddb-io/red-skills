import { readFile, stat } from "node:fs/promises";
import { compareSemver } from "../bundle-version.js";
import { decodeDevSnapshotSniff } from "../toon-snapshot.js";
import type {
  FleetTruthProbeInput,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeResult,
} from "./types.js";

export const FLEET_TRUTH_PROBE_ID = "afk.fleet-truth";
export const FLEET_TRUTH_PROBE_NAME = "AFK fleet truth";
export const FLEET_TRUTH_CANONICAL_FIX =
  "For zombie supervisors, confirm SIGTERM, verify the supervisor exits, then relaunch the fleet if requested. For version findings, restart the fleet from the current bundle.";

/** Red findings: a fault the probe MEASURED. Each one halts a boot. */
export type FleetTruthFindingKind = "zombie" | "version-skew";

/** Inconclusive observations: a measurement the probe could NOT take. Reported
 * everywhere a finding is, never red — an absent version is unknown, not skewed,
 * and a missing measurement must never masquerade as a failed one (#2752). */
export type FleetTruthNoteKind = "version-unknown";

export interface FleetTruthProbeData {
  readonly findings: readonly FleetTruthFindingKind[];
  readonly notes: readonly FleetTruthNoteKind[];
  readonly pid?: number;
  readonly target?: number;
  readonly runner?: string;
  readonly relaunchArgs?: readonly string[];
}

export interface FleetTruthProbePaths {
  readonly supervisorPidPath: string;
  readonly fleetStatePath: string;
}

export interface CollectFleetTruthProbeOptions {
  readonly nowMs?: number;
  readonly heartbeatStaleMs: number;
  readonly latestBundleVersion?: string;
  readonly ownSupervisorPid?: number;
  readonly pidLive?: (pid: number) => boolean;
}

const seconds = (ms: number): number => Math.floor(Math.max(0, ms) / 1000);

function ageMs(nowMs: number, thenMs: number | undefined): number | undefined {
  return thenMs === undefined ? undefined : Math.max(0, nowMs - thenMs);
}

function formatAge(label: string, ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : `${label}=${seconds(ms)}s`;
}

function parsePid(raw: string): number | null {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readNumberField(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function defaultPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function collectFleetTruthProbeInput(
  paths: FleetTruthProbePaths,
  options: CollectFleetTruthProbeOptions,
): Promise<FleetTruthProbeInput> {
  const nowMs = options.nowMs ?? Date.now();
  const pidLive = options.pidLive ?? defaultPidLive;
  let supervisorPid: number | null = null;
  let supervisorPidMtimeMs: number | undefined;
  let stateMtimeMs: number | undefined;
  let heartbeatEpochMs: number | undefined;
  let bundleVersion: string | undefined;
  let runner: string | undefined;
  let target: number | undefined;

  try {
    const [raw, info] = await Promise.all([readFile(paths.supervisorPidPath, "utf8"), stat(paths.supervisorPidPath)]);
    supervisorPid = parsePid(raw);
    supervisorPidMtimeMs = info.mtimeMs;
  } catch {
    supervisorPid = null;
  }

  try {
    const [raw, info] = await Promise.all([readFile(paths.fleetStatePath, "utf8"), stat(paths.fleetStatePath)]);
    stateMtimeMs = info.mtimeMs;
    const parsed = decodeDevSnapshotSniff(raw);
    const rec = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const epoch = readNumberField(rec.epoch);
    heartbeatEpochMs = epoch === undefined ? undefined : epoch * 1000;
    bundleVersion = typeof rec.bundle_version === "string" && rec.bundle_version.trim() ? rec.bundle_version : undefined;
    runner = typeof rec.runner === "string" && rec.runner.trim() ? rec.runner : undefined;
    const slots = rec.slots && typeof rec.slots === "object" ? rec.slots as Record<string, unknown> : undefined;
    target = readNumberField(slots?.total);
  } catch {
    // State absence is rendered as missing heartbeat/bundle evidence, not a crash.
  }

  return {
    supervisorPid,
    ownSupervisorPid: options.ownSupervisorPid ?? process.pid,
    supervisorPidLive: supervisorPid !== null ? pidLive(supervisorPid) : false,
    supervisorPidMtimeMs,
    stateMtimeMs,
    heartbeatEpochMs,
    nowMs,
    heartbeatStaleMs: options.heartbeatStaleMs,
    bundleVersion,
    latestBundleVersion: options.latestBundleVersion,
    runner,
    target,
  };
}

function isOwnSupervisorPid(input: FleetTruthProbeInput): boolean {
  return Boolean(input.supervisorPid && input.ownSupervisorPid && input.supervisorPid === input.ownSupervisorPid);
}

/**
 * Age of the freshest thing a live supervisor actually rewrites. The heartbeat
 * epoch and the state snapshot are refreshed every tick; the pid file is written
 * once at boot and never touched again, so its mtime measures nothing but the
 * boot instant and ages out on its own. It is therefore the LAST resort — read
 * only when no supervisor ever wrote a heartbeat at all (#2752).
 */
function supervisorHeartbeatAgeMs(input: FleetTruthProbeInput): number | undefined {
  return ageMs(input.nowMs, input.heartbeatEpochMs ?? input.stateMtimeMs ?? input.supervisorPidMtimeMs);
}

interface FleetTruthObservations {
  readonly findings: FleetTruthFindingKind[];
  readonly notes: FleetTruthNoteKind[];
}

function fleetTruthObservations(input: FleetTruthProbeInput): FleetTruthObservations {
  const findings: FleetTruthFindingKind[] = [];
  const notes: FleetTruthNoteKind[] = [];
  if (isOwnSupervisorPid(input)) return { findings, notes };
  const heartbeatAge = supervisorHeartbeatAgeMs(input);
  if (input.supervisorPidLive && heartbeatAge !== undefined && heartbeatAge > input.heartbeatStaleMs) {
    findings.push("zombie");
  }
  if (input.supervisorPidLive) {
    if (!input.bundleVersion) {
      notes.push("version-unknown");
    } else if (input.latestBundleVersion && compareSemver(input.bundleVersion, input.latestBundleVersion) !== 0) {
      findings.push("version-skew");
    }
  }
  return { findings, notes };
}

function evidence(
  input: FleetTruthProbeInput,
  findings: readonly FleetTruthFindingKind[],
  notes: readonly FleetTruthNoteKind[],
): string {
  if (!input.supervisorPid) return "no supervisor pid file";
  if (!input.supervisorPidLive) return `pid=${input.supervisorPid} is not live`;

  const parts = [
    `pid=${input.supervisorPid}`,
    `live=${String(input.supervisorPidLive)}`,
    formatAge("heartbeat_age", supervisorHeartbeatAgeMs(input)),
    formatAge("pid_mtime_age", ageMs(input.nowMs, input.supervisorPidMtimeMs)),
    formatAge("state_mtime_age", ageMs(input.nowMs, input.stateMtimeMs)),
    `threshold=${seconds(input.heartbeatStaleMs)}s`,
  ].filter((p): p is string => Boolean(p));

  if (findings.includes("version-skew")) {
    parts.push(`version_skew bundle=${input.bundleVersion} latest=${input.latestBundleVersion}`);
  } else if (notes.includes("version-unknown")) {
    parts.push(`version_unknown inconclusive latest=${input.latestBundleVersion ?? "unknown"}`);
  } else if (input.bundleVersion) {
    parts.push(`bundle=${input.bundleVersion}${input.latestBundleVersion ? ` latest=${input.latestBundleVersion}` : ""}`);
  }
  return parts.join(" ");
}

export function runFleetTruthProbe(context: OperationalProbeContext): OperationalProbeResult {
  const input = context.fleetTruth;
  if (!input) {
    return {
      id: FLEET_TRUTH_PROBE_ID,
      name: FLEET_TRUTH_PROBE_NAME,
      verdict: "ok",
      evidence: "fleet truth check not configured",
      canonicalFix: FLEET_TRUTH_CANONICAL_FIX,
    };
  }

  const { findings, notes } = fleetTruthObservations(input);
  const data: FleetTruthProbeData = {
    findings,
    notes,
    ...(input.supervisorPid ? { pid: input.supervisorPid } : {}),
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.relaunchArgs ? { relaunchArgs: input.relaunchArgs } : {}),
  };
  return {
    id: FLEET_TRUTH_PROBE_ID,
    name: FLEET_TRUTH_PROBE_NAME,
    verdict: findings.length > 0 ? "red" : "ok",
    evidence: evidence(input, findings, notes),
    canonicalFix: FLEET_TRUTH_CANONICAL_FIX,
    fix: findings.includes("zombie")
      ? {
          gate: "confirm",
          description: "SIGTERM the stale-but-live fleet supervisor and verify it exits",
        }
      : undefined,
    data,
  };
}

function fleetTruthData(finding: OperationalProbeResult): FleetTruthProbeData | undefined {
  const data = finding.data;
  if (!data || typeof data !== "object") return undefined;
  const rec = data as Partial<FleetTruthProbeData>;
  return Array.isArray(rec.findings) ? rec as FleetTruthProbeData : undefined;
}

export async function applyFleetTruthFix(
  finding: OperationalProbeResult,
  deps: OperationalProbeFixDeps,
): Promise<OperationalProbeFixResult> {
  const data = fleetTruthData(finding);
  if (!data?.findings.includes("zombie") || !data.pid) {
    return { probeId: finding.id, status: "noop", evidence: "no zombie supervisor repair is needed" };
  }

  const confirmed = await deps.confirm(finding);
  if (!confirmed) return { probeId: finding.id, status: "declined", evidence: "operator declined fix" };
  if (!deps.terminateSupervisor) {
    return { probeId: finding.id, status: "noop", evidence: "supervisor SIGTERM repair is not wired" };
  }

  const exited = await deps.terminateSupervisor(data.pid);
  if (!exited) {
    return { probeId: finding.id, status: "noop", evidence: `supervisor pid=${data.pid} still live after SIGTERM` };
  }

  // The repair ENDS here. ADR 0130 Amendment 4 removed the per-project process
  // (#2909), so there is nothing left to relaunch: work resumes by registering
  // the project with the daemon, which is an operator's `project_start` and not
  // a doctor reaching for a launcher. Naming the route beats a silent stop.
  return {
    probeId: finding.id,
    status: "applied",
    evidence: "supervisor pid exited; register the project again with `project_start` to resume work",
  };
}

export async function terminateSupervisorPid(
  pid: number,
  options: { readonly pollMs?: number; readonly timeoutMs?: number } = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  while (Date.now() < deadline) {
    if (!defaultPidLive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !defaultPidLive(pid);
}

export const fleetTruthProbe: OperationalProbe = {
  id: FLEET_TRUTH_PROBE_ID,
  name: FLEET_TRUTH_PROBE_NAME,
  canonicalFix: FLEET_TRUTH_CANONICAL_FIX,
  run: runFleetTruthProbe,
  applyFix: applyFleetTruthFix,
};
