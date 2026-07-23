import type {
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeResult,
  QueueVisibilityTransportFailure,
  QueueVisibilityTransportSurface,
} from "./types.js";

export const QUEUE_VISIBILITY_PROBE_ID = "afk.queue-visibility";
export const QUEUE_VISIBILITY_PROBE_NAME = "AFK queue visibility";
export const QUEUE_VISIBILITY_CANONICAL_FIX =
  "Restore GitHub queue visibility for the AFK engine; if SSO is reported, run `gh auth refresh -h github.com -s repo,read:org,workflow` and authorize the token for the GitHub organization SSO prompt.";

export type QueueVisibilityFailureClass =
  | "sso-or-scope"
  | "rate-limit"
  | "graphql-transport"
  | "rest-transport"
  | "generic-transport";

export interface QueueVisibilityProbeData {
  readonly label: string;
  readonly engineCount?: number;
  readonly restCount?: number;
  readonly engineIssues?: readonly number[];
  readonly restIssues?: readonly number[];
  readonly differingIssues?: readonly number[];
  readonly transient?: boolean;
  readonly classification?: QueueVisibilityFailureClass;
  readonly surface?: QueueVisibilityTransportSurface;
}

interface QueueVisibilitySnapshot {
  readonly engineIssues: readonly number[];
  readonly restIssues: readonly number[];
}

type QueueVisibilitySample =
  | { readonly ok: true; readonly snapshot: QueueVisibilitySnapshot }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly engineIssues?: readonly number[];
    };

const DEFAULT_RESAMPLE_DELAY_MS = 250;

const SSO_FIX =
  "Run `gh auth refresh -h github.com -s repo,read:org,workflow`, then open the GitHub organization SSO authorization prompt for the affected org and authorize the gh token.";
const RATE_LIMIT_FIX =
  "Wait for the GitHub primary/secondary rate limit window to reset, then rerun `/afk`; if this repeats, reduce fleet concurrency before retrying.";
const GRAPHQL_FIX =
  "Repair GitHub GraphQL access for `gh issue list --json`: refresh the gh token scopes and verify org authorization before restarting `/afk`.";
const REST_FIX =
  "Repair GitHub REST access for `gh api` queue reads: refresh the gh token scopes and verify org authorization before restarting `/afk`.";
const GENERIC_FIX =
  "Inspect `gh auth status` and network reachability, then rerun `/afk` once GitHub issue listing succeeds.";

function transportText(failure: unknown): string {
  if (failure instanceof Error) {
    const rec = failure as Error & Partial<QueueVisibilityTransportFailure>;
    return [failure.message, rec.stdout, rec.stderr].filter(Boolean).join("\n");
  }
  if (failure && typeof failure === "object") {
    const rec = failure as Partial<QueueVisibilityTransportFailure>;
    return [rec.message, rec.stdout, rec.stderr].filter(Boolean).join("\n");
  }
  return String(failure ?? "");
}

function transportSurface(failure: unknown): QueueVisibilityTransportSurface {
  if (failure && typeof failure === "object") {
    const surface = (failure as Partial<QueueVisibilityTransportFailure>).surface;
    if (surface === "graphql" || surface === "rest" || surface === "rest-cache" || surface === "unknown") return surface;
  }
  return "unknown";
}

export function classifyQueueVisibilityTransportFailure(failure: unknown): QueueVisibilityFailureClass {
  const text = transportText(failure);
  if (
    /saml|single sign-on|sso|x-github-sso|resource protected by organization saml enforcement|authorize.*oauth/i.test(text) ||
    /requires one of the following oauth scopes|insufficient(_|\s)?scope|missing.*scope|must have.*scope/i.test(text)
  ) {
    return "sso-or-scope";
  }
  if (/rate limit|secondary rate|abuse detection|too many requests|\b429\b/i.test(text)) return "rate-limit";
  const surface = transportSurface(failure);
  if (surface === "graphql") return "graphql-transport";
  if (surface === "rest" || surface === "rest-cache") return "rest-transport";
  return "generic-transport";
}

function fixForClassification(classification: QueueVisibilityFailureClass): string {
  switch (classification) {
    case "sso-or-scope":
      return SSO_FIX;
    case "rate-limit":
      return RATE_LIMIT_FIX;
    case "graphql-transport":
      return GRAPHQL_FIX;
    case "rest-transport":
      return REST_FIX;
    case "generic-transport":
      return GENERIC_FIX;
  }
}

function failureEvidence(classification: QueueVisibilityFailureClass, surface: QueueVisibilityTransportSurface): string {
  return `queue listing failed (${classification}, surface=${surface})`;
}

function normalizeIssueNumbers(issues: readonly number[]): number[] {
  return [...new Set(issues.filter((issue) => Number.isInteger(issue) && issue > 0))].sort((a, b) => a - b);
}

function differingIssues(snapshot: QueueVisibilitySnapshot): number[] {
  const engine = new Set(snapshot.engineIssues);
  const rest = new Set(snapshot.restIssues);
  return [...engine].filter((issue) => !rest.has(issue))
    .concat([...rest].filter((issue) => !engine.has(issue)))
    .sort((a, b) => a - b);
}

function issueNumbersEvidence(issues: readonly number[]): string {
  return issues.map((issue) => `#${issue}`).join(", ");
}

async function sampleQueueVisibility(input: NonNullable<OperationalProbeContext["queueVisibility"]>): Promise<QueueVisibilitySample> {
  let engineIssues: readonly number[];
  try {
    engineIssues = normalizeIssueNumbers(await input.listEngineCandidates());
  } catch (error) {
    return { ok: false, error };
  }

  try {
    return {
      ok: true,
      snapshot: {
        engineIssues,
        restIssues: normalizeIssueNumbers(await input.listRestQueue()),
      },
    };
  } catch (error) {
    return { ok: false, error, engineIssues };
  }
}

function transportFailureResult(label: string, sample: Extract<QueueVisibilitySample, { ok: false }>): OperationalProbeResult {
  const classification = classifyQueueVisibilityTransportFailure(sample.error);
  const surface = transportSurface(sample.error);
  const engineCount = sample.engineIssues?.length;
  return {
    id: QUEUE_VISIBILITY_PROBE_ID,
    name: QUEUE_VISIBILITY_PROBE_NAME,
    verdict: "red",
    evidence: failureEvidence(classification, surface),
    canonicalFix: fixForClassification(classification),
    data: {
      label,
      ...(engineCount === undefined ? {} : { engineCount, engineIssues: sample.engineIssues }),
      classification,
      surface,
    } satisfies QueueVisibilityProbeData,
  };
}

export async function runQueueVisibilityProbe(context: OperationalProbeContext): Promise<OperationalProbeResult> {
  const input = context.queueVisibility;
  const label = input?.label ?? "ready-for-agent";
  if (!input) {
    return {
      id: QUEUE_VISIBILITY_PROBE_ID,
      name: QUEUE_VISIBILITY_PROBE_NAME,
      verdict: "ok",
      evidence: "queue visibility check not configured",
      canonicalFix: QUEUE_VISIBILITY_CANONICAL_FIX,
    };
  }

  const first = await sampleQueueVisibility(input);
  if (!first.ok) return transportFailureResult(label, first);

  const firstDifference = differingIssues(first.snapshot);
  if (firstDifference.length > 0) {
    const delayMs = input.resampleDelayMs ?? DEFAULT_RESAMPLE_DELAY_MS;
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

    const second = await sampleQueueVisibility(input);
    if (!second.ok) return transportFailureResult(label, second);

    const secondDifference = differingIssues(second.snapshot);
    if (secondDifference.length === 0) {
      const engineCount = second.snapshot.engineIssues.length;
      const restCount = second.snapshot.restIssues.length;
      return {
        id: QUEUE_VISIBILITY_PROBE_ID,
        name: QUEUE_VISIBILITY_PROBE_NAME,
        verdict: "ok",
        evidence: `info: transient queue mismatch cleared on re-sample; first differing issues: ${issueNumbersEvidence(firstDifference)}`,
        canonicalFix: QUEUE_VISIBILITY_CANONICAL_FIX,
        data: {
          label,
          engineCount,
          restCount,
          engineIssues: second.snapshot.engineIssues,
          restIssues: second.snapshot.restIssues,
          differingIssues: firstDifference,
          transient: true,
        } satisfies QueueVisibilityProbeData,
      };
    }

    const engineCount = second.snapshot.engineIssues.length;
    const restCount = second.snapshot.restIssues.length;
    return {
      id: QUEUE_VISIBILITY_PROBE_ID,
      name: QUEUE_VISIBILITY_PROBE_NAME,
      verdict: "red",
      evidence: `engine sees ${engineCount} open ${label}; REST sees ${restCount}; differing issues: ${issueNumbersEvidence(secondDifference)}`,
      canonicalFix: QUEUE_VISIBILITY_CANONICAL_FIX,
      data: {
        label,
        engineCount,
        restCount,
        engineIssues: second.snapshot.engineIssues,
        restIssues: second.snapshot.restIssues,
        differingIssues: secondDifference,
      } satisfies QueueVisibilityProbeData,
    };
  }

  const engineCount = first.snapshot.engineIssues.length;
  const restCount = first.snapshot.restIssues.length;
  return {
    id: QUEUE_VISIBILITY_PROBE_ID,
    name: QUEUE_VISIBILITY_PROBE_NAME,
    verdict: "ok",
    evidence: `engine and REST both see ${engineCount} open ${label}`,
    canonicalFix: QUEUE_VISIBILITY_CANONICAL_FIX,
    data: {
      label,
      engineCount,
      restCount,
      engineIssues: first.snapshot.engineIssues,
      restIssues: first.snapshot.restIssues,
    } satisfies QueueVisibilityProbeData,
  };
}

export const queueVisibilityProbe: OperationalProbe = {
  id: QUEUE_VISIBILITY_PROBE_ID,
  name: QUEUE_VISIBILITY_PROBE_NAME,
  canonicalFix: QUEUE_VISIBILITY_CANONICAL_FIX,
  run: runQueueVisibilityProbe,
};
