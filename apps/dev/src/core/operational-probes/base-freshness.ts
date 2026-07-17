import type {
  BaseFreshnessProbeInput,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeResult,
} from "./types.js";

export const BASE_FRESHNESS_PROBE_ID = "afk.base-freshness";
export const BASE_FRESHNESS_PROBE_NAME = "AFK local trunk freshness";
export const BASE_FRESHNESS_CANONICAL_FIX =
  "Boot auto-applies the local-trunk fast-forward from origin when the shared finalizer guard passes: on-trunk, clean tree, and local ancestor only; otherwise confirm the same guarded fix manually.";

export interface BaseFreshnessProbeData extends BaseFreshnessProbeInput {
  readonly finding?: "local-trunk-behind-origin";
}

function guardVerdict(input: BaseFreshnessProbeInput): string {
  if (input.guard.guard === "passed") return `guard=passed (${input.guard.evidence})`;
  return `guard=refused (${input.guard.evidence})`;
}

function evidence(input: BaseFreshnessProbeInput, finding?: BaseFreshnessProbeData["finding"]): string {
  const ahead = input.ahead ?? 0;
  const behind = input.behind ?? 0;
  const ref = `${input.remote}/${input.trunk}`;
  if (!input.localSha || !input.remoteSha) {
    return `local ${input.trunk} or ${ref} is unresolved; ${guardVerdict(input)}`;
  }
  if (finding === "local-trunk-behind-origin") {
    return `local ${input.trunk} is ${behind} commit(s) behind ${ref}; ahead=${ahead}; ${guardVerdict(input)}`;
  }
  return `local ${input.trunk} is not behind ${ref}; ahead=${ahead} behind=${behind}; ${guardVerdict(input)}`;
}

export function runBaseFreshnessProbe(context: OperationalProbeContext): OperationalProbeResult {
  const input = context.baseFreshness;
  if (!input) {
    return {
      id: BASE_FRESHNESS_PROBE_ID,
      name: BASE_FRESHNESS_PROBE_NAME,
      verdict: "ok",
      evidence: "base freshness check not configured",
      canonicalFix: BASE_FRESHNESS_CANONICAL_FIX,
    };
  }

  const behind = input.behind ?? 0;
  const finding = behind > 0 ? "local-trunk-behind-origin" : undefined;
  return {
    id: BASE_FRESHNESS_PROBE_ID,
    name: BASE_FRESHNESS_PROBE_NAME,
    verdict: finding ? "red" : "ok",
    evidence: evidence(input, finding),
    canonicalFix: BASE_FRESHNESS_CANONICAL_FIX,
    fix: finding
      ? {
          gate: "confirm",
          description: "fast-forward local trunk from origin under the finalizer guard",
        }
      : undefined,
    data: { ...input, finding } satisfies BaseFreshnessProbeData,
  };
}

export async function applyBaseFreshnessFix(
  finding: OperationalProbeResult,
  deps: OperationalProbeFixDeps,
): Promise<OperationalProbeFixResult> {
  const data = finding.data as Partial<BaseFreshnessProbeData> | undefined;
  if (data?.finding !== "local-trunk-behind-origin" || !data.remote || !data.trunk) {
    return { probeId: finding.id, status: "noop", evidence: "no base freshness repair is needed" };
  }

  const confirmed = await deps.confirm(finding);
  if (!confirmed) {
    return { probeId: finding.id, status: "declined", evidence: "operator declined fix" };
  }

  if (!deps.fastForwardLocalBase) {
    return { probeId: finding.id, status: "noop", evidence: "base fast-forward repair is not wired" };
  }

  const result = await deps.fastForwardLocalBase({ remote: data.remote, target: data.trunk });
  if (result.action === "fast-forward") {
    return { probeId: finding.id, status: "applied", evidence: result.evidence };
  }
  return { probeId: finding.id, status: "noop", evidence: `guard refused: ${result.evidence}` };
}

export const baseFreshnessProbe: OperationalProbe = {
  id: BASE_FRESHNESS_PROBE_ID,
  name: BASE_FRESHNESS_PROBE_NAME,
  canonicalFix: BASE_FRESHNESS_CANONICAL_FIX,
  run: runBaseFreshnessProbe,
  applyFix: applyBaseFreshnessFix,
};
