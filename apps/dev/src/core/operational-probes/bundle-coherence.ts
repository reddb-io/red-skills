import { compareSemver } from "../bundle-version.js";
import type {
  BundleCoherenceProbeInput,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeResult,
} from "./types.js";

export const BUNDLE_COHERENCE_PROBE_ID = "afk.bundle-coherence";
export const BUNDLE_COHERENCE_PROBE_NAME = "AFK bundle coherence";
export const BUNDLE_COHERENCE_CANONICAL_FIX =
  "Run any dev shim to reconcile the stable pointer with the newest cached lane bundle; if npm is ahead, let self-update retry or warm the package cache, then restart any stale fleet.";

const DEFAULT_STALE_FAILURE_MS = 4 * 60 * 60 * 1000;

export type BundleCoherenceFindingKind =
  | "pointer-behind-lane"
  | "pointer-ahead-of-lane"
  | "pointer-behind-npm"
  | "lane-behind-npm"
  | "stale-failed-check"
  | "stale-successful-check"
  | "undated-successful-check";

function effectivePointer(input: BundleCoherenceProbeInput): string | undefined {
  return input.pointerVersion ?? input.installedVersion;
}

function findings(input: BundleCoherenceProbeInput): BundleCoherenceFindingKind[] {
  const out: BundleCoherenceFindingKind[] = [];
  const pointer = effectivePointer(input);
  if (pointer && input.laneNewestVersion && compareSemver(input.laneNewestVersion, pointer) > 0) {
    out.push("pointer-behind-lane");
  }
  const newestAvailableLane = input.laneNewestVersion ?? input.installedVersion;
  if (
    input.pointerVersion &&
    newestAvailableLane &&
    compareSemver(input.pointerVersion, newestAvailableLane) > 0
  ) {
    out.push("pointer-ahead-of-lane");
  }
  if (pointer && input.npmNewestVersion && compareSemver(input.npmNewestVersion, pointer) > 0) {
    out.push("pointer-behind-npm");
  }
  const lane = input.laneNewestVersion ?? pointer;
  if (lane && input.npmNewestVersion && compareSemver(input.npmNewestVersion, lane) > 0) {
    out.push("lane-behind-npm");
  }
  if (input.lastFailureAgeMs !== undefined && input.lastFailureAgeMs > DEFAULT_STALE_FAILURE_MS) {
    out.push("stale-failed-check");
  }
  if (input.lastStatus === "updated" || input.lastStatus === "up-to-date") {
    if (input.lastCheckAgeMs === undefined) {
      out.push("undated-successful-check");
    } else if (input.lastCheckAgeMs > DEFAULT_STALE_FAILURE_MS) {
      out.push("stale-successful-check");
    }
  }
  return out;
}

function age(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function evidence(input: BundleCoherenceProbeInput, fs: readonly BundleCoherenceFindingKind[]): string {
  const parts = [
    `installed=${input.installedVersion ?? "unknown"}`,
    `pointer=${input.pointerVersion ?? "none"}`,
    `lane=${input.laneNewestVersion ?? "none"}`,
    `npm=${input.npmNewestVersion ?? (input.npmError ? "unknown" : "not-checked")}`,
  ];
  if (input.npmError) parts.push("npm_error=present");
  const checkAge = age(input.lastCheckAgeMs);
  if (input.lastStatus === "updated" || input.lastStatus === "up-to-date") {
    parts.push(checkAge ? `last_check=${input.lastStatus}@${checkAge}` : "last_check=undated");
    const shipped = versionsSinceCheck(input.pointerVersion ?? input.installedVersion, input.npmNewestVersion);
    if (shipped !== undefined) parts.push(`versions_since_check=${shipped}`);
  }
  const failureAge = age(input.lastFailureAgeMs);
  if (failureAge) parts.push(`last_failure_age=${failureAge}`);
  if (input.lastError) parts.push("last_error=present");
  if (fs.length > 0) parts.push(`findings=${fs.join(",")}`);
  return parts.join(" ");
}

function versionsSinceCheck(current: string | undefined, published: string | undefined): number | undefined {
  const left = /^(\d+)\.(\d+)\.(\d+)/.exec(current ?? "");
  const right = /^(\d+)\.(\d+)\.(\d+)/.exec(published ?? "");
  if (!left || !right || left[1] !== right[1] || left[2] !== right[2]) return undefined;
  return Math.max(0, Number(right[3]) - Number(left[3]));
}

export function runBundleCoherenceProbe(context: OperationalProbeContext): OperationalProbeResult {
  const input = context.bundleCoherence;
  if (!input) {
    return {
      id: BUNDLE_COHERENCE_PROBE_ID,
      name: BUNDLE_COHERENCE_PROBE_NAME,
      verdict: "ok",
      evidence: "bundle coherence check not configured",
      canonicalFix: BUNDLE_COHERENCE_CANONICAL_FIX,
    };
  }
  const fs = findings(input);
  const selfHealable = fs.filter((finding) => finding === "pointer-behind-lane");
  const blocking = fs.filter((finding) => finding !== "pointer-behind-lane");
  return {
    id: BUNDLE_COHERENCE_PROBE_ID,
    name: BUNDLE_COHERENCE_PROBE_NAME,
    verdict: blocking.length > 0 ? "red" : "ok",
    evidence: evidence(input, fs),
    canonicalFix: BUNDLE_COHERENCE_CANONICAL_FIX,
    data: { findings: fs, ...(selfHealable.length > 0 ? { selfHealable } : {}) },
  };
}

export const bundleCoherenceProbe: OperationalProbe = {
  id: BUNDLE_COHERENCE_PROBE_ID,
  name: BUNDLE_COHERENCE_PROBE_NAME,
  canonicalFix: BUNDLE_COHERENCE_CANONICAL_FIX,
  run: runBundleCoherenceProbe,
};
