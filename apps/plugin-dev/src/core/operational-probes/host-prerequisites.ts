import { describeSearchedPath, splitSearchPath } from "@reddb-io/shared/engine-node.js";
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
    // A missing tool names WHERE the lookup looked, because "missing: node" on a
    // host that has node reads as a lie until someone reconstructs the sanitized
    // PATH by hand (#3064). Node earns one sentence more: the engine printing
    // this is itself running on a node whose absolute path it holds.
    const where = describeSearchedPath(input.searchedPath);
    const engineNote =
      missing.includes("node") && (input.engineNodePath ?? "").trim() !== ""
        ? `; the engine's own node (${input.engineNodePath}) is the expected fallback and did not resolve either`
        : "";
    return {
      id: HOST_PREREQUISITE_PROBE_ID,
      name: HOST_PREREQUISITE_PROBE_NAME,
      verdict: "red",
      evidence: `missing required host tools: ${names} (${where})${engineNote}`,
      canonicalFix: `Install missing host prerequisites: ${names}. Verify after installation: command -v ${missing.join(" ")}`,
      data: {
        missing,
        searchedDirectories: splitSearchPath(input.searchedPath),
        ...(input.engineNodePath != null ? { engineNodePath: input.engineNodePath } : {}),
      },
    };
  }

  const bashVersion = parseBashVersion(input.bashVersion);
  if (!bashVersion) {
    const observed = input.bashVersion?.trim() || "no output";
    const failure = input.bashVersionError
      ? input.bashVersionExitCode === undefined
        ? `bash --version failed: ${input.bashVersionError}`
        : `bash --version exited ${input.bashVersionExitCode}: ${input.bashVersionError}`
      : input.bashVersionExitCode === undefined
        ? `could not determine bash version from: ${observed}`
        : `bash --version exited ${input.bashVersionExitCode} with no diagnostic`;
    return {
      id: HOST_PREREQUISITE_PROBE_ID,
      name: HOST_PREREQUISITE_PROBE_NAME,
      verdict: "red",
      evidence: failure,
      canonicalFix: `Install a working bash ${MINIMUM_BASH_VERSION} or newer and expose it on PATH. Verify after installation: bash --version`,
      data: {
        bashVersionOutput: observed,
        bashVersionExitCode: input.bashVersionExitCode,
        bashVersionError: input.bashVersionError,
        minimumBashVersion: MINIMUM_BASH_VERSION,
      },
    };
  }
  if (olderThanMinimum(bashVersion)) {
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
