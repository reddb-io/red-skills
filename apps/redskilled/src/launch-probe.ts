/**
 * launch-probe — asked at registration, because 22 deaths later is too late.
 *
 * A registration names an argv the daemon will birth Workers from. When that
 * argv cannot run — a version that was never published, a package that no
 * longer carries the binary, a shim pointing at a deleted bundle — the daemon
 * discovers it one birth at a time: #4006 died 22 times in a row before a human
 * read a log, and only then because the project's birth breaker latched.
 *
 * **Every shipped binary answers `--version` offline without a working machine**
 * (the shipped-binary guard), which is exactly what makes it usable as a probe:
 * one process, no work, no side effect, and a truthful answer about whether the
 * thing the registration names exists at all.
 *
 * Inconclusive is a first-class answer. A cold npx cache or a slow disk is not
 * a broken launch, and refusing a registration because a probe timed out would
 * trade one silent failure for a louder wrong one.
 *
 * PURE except for the injected prober.
 */
import { spawnSync } from "node:child_process";

export type LaunchProbeVerdict = "runnable" | "unrunnable" | "inconclusive";

export interface LaunchProbeResult {
  readonly status: number | null;
  readonly timedOut?: boolean;
  readonly error?: string;
}

/** The argv that asks a registered launch to identify itself. PURE. */
export function launchProbeArgv(argv: readonly string[]): readonly string[] {
  return [...argv, "--version"];
}

/**
 * What one probe answer means for the registration that produced it. PURE.
 *
 * A non-zero exit is the interesting case and it is deliberately NOT a refusal
 * on its own: a binary that ran and disliked its arguments still exists, and
 * the registration's argv may carry flags this probe appended `--version` to.
 * Refusal is reserved for "nothing ran" — a spawn error, or an exit status the
 * shell uses for a command it could not find.
 */
export function classifyLaunchProbe(result: LaunchProbeResult): LaunchProbeVerdict {
  if (result.timedOut === true) return "inconclusive";
  if (result.error != null) {
    return /ENOENT|not found|no such file/i.test(result.error) ? "unrunnable" : "inconclusive";
  }
  if (result.status === 0) return "runnable";
  // 127 is "command not found" and 126 is "found but not executable", the two
  // answers a shell gives for a launch nobody could have run.
  return result.status === 127 || result.status === 126 ? "unrunnable" : "runnable";
}

/**
 * The default prober: one bounded process that asks the launch to name itself.
 *
 * Bounded twice — a deadline and no shell — because this runs inside the
 * registration path a client is waiting on, and a probe that hung would turn a
 * cold npx cache into a hung `drain`.
 */
export function defaultLaunchProbe(argv: readonly string[]): LaunchProbeResult {
  const [command, ...args] = argv;
  if (command == null) return { status: null, error: "the launch named no command" };
  const probe = spawnSync(command, args, {
    timeout: LAUNCH_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  return {
    status: probe.status,
    ...(probe.signal === "SIGTERM" && probe.status == null ? { timedOut: true } : {}),
    ...(probe.error == null ? {} : { error: probe.error.message }),
  };
}

/** How long a probe may take before its answer stops being worth waiting for. */
export const LAUNCH_PROBE_TIMEOUT_MS = 20_000;

/** The refusal a client reads when its launch could not run. PURE. */
export function launchProbeRefusal(projectLabel: string, argv: readonly string[]): string {
  return (
    `redskilled refuses to register project ${JSON.stringify(projectLabel)}: the launch it named cannot run — ` +
    `${JSON.stringify(argv.join(" "))} did not answer \`--version\`. Every shipped binary answers it offline, so ` +
    `a launch that cannot is one no Worker could have been born from. The canonical form is ` +
    `\`npx -y -p @reddb-io/red-skills@<version> <binary>\` (ADR 0091).`
  );
}
