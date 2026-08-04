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
  "Boot auto-applies local-trunk reconciliation from origin when the shared finalizer guard passes: on-trunk, clean tree, and either a local ancestor or every local-only commit patch-equivalent to an origin commit; otherwise confirm the same guarded fix manually.";

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
          description: "reconcile local trunk from origin under the finalizer guard",
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
  const reconciled = reconcileBaseFreshnessEvidence(finding, result.evidence);
  return {
    probeId: finding.id,
    status: "noop",
    evidence: `guard refused: ${result.evidence}`,
    // Only when the finding's own verdict would otherwise contradict the fix. A
    // finding that already read `guard=refused` agrees with it as it stands.
    ...(reconciled === finding ? {} : { reconciled }),
  };
}

/**
 * Rewrite a base-freshness finding so its evidence agrees with what the fix
 * actually did (#3155). The probe evaluated the guard a moment BEFORE the
 * fast-forward ran; when the fast-forward then declines, the finding still reads
 * `guard=passed` beside a repair that errored out, and nothing in the receipt
 * reads as refused. A verdict the next command overrules is worse than no
 * verdict — it sends the reader to the wrong subsystem.
 */
export function reconcileBaseFreshnessEvidence(
  finding: OperationalProbeResult,
  fixEvidence: string,
): OperationalProbeResult {
  const data = finding.data as Partial<BaseFreshnessProbeData> | undefined;
  // Nothing to reconcile: a finding that already reported a refusal agrees with a
  // fix that could not apply, and rewriting it would only lose the real reason.
  if (!data?.trunk || !data.remote || data.guard?.guard !== "passed") return finding;
  const refuted: BaseFreshnessProbeInput["guard"] = {
    ...data.guard,
    guard: "refused",
    evidence: fixEvidence,
  };
  const reconciled = { ...data, guard: refuted } as BaseFreshnessProbeData;
  return {
    ...finding,
    evidence: evidence(reconciled, data.finding),
    data: reconciled,
  };
}

export const baseFreshnessProbe: OperationalProbe = {
  id: BASE_FRESHNESS_PROBE_ID,
  name: BASE_FRESHNESS_PROBE_NAME,
  canonicalFix: BASE_FRESHNESS_CANONICAL_FIX,
  run: runBaseFreshnessProbe,
  applyFix: applyBaseFreshnessFix,
};
