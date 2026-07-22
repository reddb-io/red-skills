import type {
  HostPrerequisiteCommand,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeResult,
} from "./types.js";

export const HOST_PREREQUISITE_PROBE_ID = "afk.host-prerequisites";
export const HOST_PREREQUISITE_PROBE_NAME = "AFK host prerequisites";
export const MINIMUM_BASH_VERSION = "3.2.0";
export const HOST_PREREQUISITE_CANONICAL_FIX =
  "Install every required AFK host tool, expose it on PATH, and use a supported Bash version.";

export const HOST_PREREQUISITE_COMMANDS: readonly HostPrerequisiteCommand[] = [
  "bash",
  "git",
  "jq",
  "gh",
  "node",
  "timeout",
  "ps",
];

function parseBashVersion(output: string | undefined): readonly [number, number, number] | undefined {
  const match = output?.match(/version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function olderThanMinimum(version: readonly [number, number, number]): boolean {
  const minimum = [3, 2, 0] as const;
  for (let index = 0; index < version.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index]! < minimum[index]!;
  }
  return false;
}

export function runHostPrerequisiteProbe(context: OperationalProbeContext): OperationalProbeResult {
  const input = context.hostPrerequisites;
  if (!input) {
    return {
      id: HOST_PREREQUISITE_PROBE_ID,
      name: HOST_PREREQUISITE_PROBE_NAME,
      verdict: "ok",
      evidence: "host prerequisite check not configured",
      canonicalFix: HOST_PREREQUISITE_CANONICAL_FIX,
    };
  }

  const missing = HOST_PREREQUISITE_COMMANDS.filter((command) => !input.commands[command]);
  if (missing.length > 0) {
    const names = missing.join(", ");
    return {
      id: HOST_PREREQUISITE_PROBE_ID,
      name: HOST_PREREQUISITE_PROBE_NAME,
      verdict: "red",
      evidence: `missing required host tools: ${names}`,
      canonicalFix: `Install missing host prerequisites: ${names}. Verify after installation: command -v ${missing.join(" ")}`,
      data: { missing },
    };
  }

  const bashVersion = parseBashVersion(input.bashVersion);
  if (bashVersion && olderThanMinimum(bashVersion)) {
    const observed = bashVersion.join(".");
    return {
      id: HOST_PREREQUISITE_PROBE_ID,
      name: HOST_PREREQUISITE_PROBE_NAME,
      verdict: "red",
      evidence: `bash ${observed} is older than required ${MINIMUM_BASH_VERSION}`,
      canonicalFix: `Upgrade bash to ${MINIMUM_BASH_VERSION} or newer and expose it on PATH. Verify after upgrade: bash --version`,
      data: { bashVersion: observed, minimumBashVersion: MINIMUM_BASH_VERSION },
    };
  }

  return {
    id: HOST_PREREQUISITE_PROBE_ID,
    name: HOST_PREREQUISITE_PROBE_NAME,
    verdict: "ok",
    evidence: "all required host tools are available",
    canonicalFix: HOST_PREREQUISITE_CANONICAL_FIX,
  };
}

export const hostPrerequisiteProbe: OperationalProbe = {
  id: HOST_PREREQUISITE_PROBE_ID,
  name: HOST_PREREQUISITE_PROBE_NAME,
  canonicalFix: HOST_PREREQUISITE_CANONICAL_FIX,
  run: runHostPrerequisiteProbe,
};
