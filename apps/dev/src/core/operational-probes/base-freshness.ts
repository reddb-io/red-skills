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

/**
 * The guard refusals a Worker session may ignore: the operator's own WIP.
 *
 * Both name one fact — the primary checkout holds uncommitted work — and differ
 * only in how much the guard could say about it. `clean-tree` is the tree it
 * could not read or found merely dirty; `dirt-collision` is the sharper reading,
 * where a dirty path also moved upstream. Neither reaches a Worker, which
 * branches from the fork SHA the host granted (ADR 0138) and never from the
 * operator's local trunk.
 *
 * Listing only `clean-tree` cost four Workers and a ten-minute birth-breaker
 * cooldown on 2026-08-08: two dirty files in the primary checkout, on a branch
 * none of those Workers would touch, killed three of them at boot in seventeen
 * seconds. The exemption already claimed to cover "the primary has uncommitted
 * WIP"; it just did not name the second way the guard says so.
 *
 * Deliberately NOT here: `on-trunk`, `ancestor`, `superseded-commits`, `fetch`
 * and `merge`. Those are not WIP, and widening past the stated intent is how an
 * exemption stops meaning anything.
 */
const WORKER_EXEMPT_GUARD_CONDITIONS: ReadonlySet<string> = new Set([
  "clean-tree",
  "dirt-collision",
]);

/**
 * May a Worker session proceed past this red base-freshness finding? PURE.
 *
 * It lives beside the probe rather than inside `boot.ts` because it is a fact
 * about base freshness, not about booting: the probe owns what the finding means
 * and therefore owns which readings of it a Worker may ignore.
 */
export function isWorkerExemptBaseFreshnessFinding(finding: {
  readonly id: string;
  readonly data?: unknown;
}): boolean {
  if (finding.id !== BASE_FRESHNESS_PROBE_ID) return false;
  const data = finding.data as Partial<BaseFreshnessProbeData> | undefined;
  if (data?.finding !== "local-trunk-behind-origin") return false;
  if (data.guard?.guard === "passed") return true;
  return WORKER_EXEMPT_GUARD_CONDITIONS.has(data.guard?.failedCondition ?? "");
}
