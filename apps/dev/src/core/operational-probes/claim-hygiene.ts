import { renderClaimComment, type ClaimRecord } from "../claim.js";
import { classifyClaim, DEFAULT_CLAIM_STALENESS } from "../claim-staleness.js";
import type {
  ClaimHygieneIssueInput,
  ClaimHygieneProbeInput,
  ClaimHygieneWorkerPidState,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeResult,
} from "./types.js";

export const CLAIM_HYGIENE_PROBE_ID = "afk.claim-hygiene";
export const CLAIM_HYGIENE_PROBE_NAME = "AFK claim hygiene";
export const CLAIM_HYGIENE_CANONICAL_FIX =
  "For dangling afk claim markers owned by this machine with a dead worker pid, confirm per issue and post a matching concede marker. Report foreign claim namespaces without mutation.";

type ClaimMarkerKind = "claim" | "concede";

interface GenericClaimMarker {
  readonly namespace: string;
  readonly commentId: number;
  readonly worker: string;
  readonly kind: ClaimMarkerKind;
  readonly runner?: string;
  readonly createdAt?: string;
}

interface DanglingClaim {
  readonly issue: number;
  readonly marker: GenericClaimMarker;
}

interface ClaimHygieneConcedeAction {
  readonly issue: number;
  readonly markerComment: number;
  readonly namespace: string;
  readonly worker: string;
  readonly runner?: string;
  readonly pidState: ClaimHygieneWorkerPidState;
}

interface ClaimHygieneReportEntry {
  readonly issue: number;
  readonly markerComment: number;
  readonly namespace: string;
  readonly worker: string;
}

interface ClaimHygieneProbeData {
  readonly actions: readonly ClaimHygieneConcedeAction[];
  readonly foreign: readonly ClaimHygieneReportEntry[];
  readonly unknown: readonly ClaimHygieneReportEntry[];
  readonly liveOwn: number;
  readonly unknownOwn: number;
}

const CLAIM_MARKER_RE = /<!--\s*([a-z][a-z0-9_-]*):claim\s+([^>]*?)\s*-->/gi;

function parseFields(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tok of raw.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    out.set(tok.slice(0, eq), tok.slice(eq + 1));
  }
  return out;
}

function parseGenericClaimMarkers(issue: ClaimHygieneIssueInput): GenericClaimMarker[] {
  const out: GenericClaimMarker[] = [];
  for (const comment of issue.comments) {
    if (!Number.isFinite(comment.id) || typeof comment.body !== "string") continue;
    CLAIM_MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CLAIM_MARKER_RE.exec(comment.body)) !== null) {
      const namespace = match[1].toLowerCase();
      const fields = parseFields(match[2]);
      const worker = fields.get("worker");
      if (!worker) continue;
      out.push({
        namespace,
        commentId: comment.id,
        worker,
        kind: fields.get("kind") === "concede" ? "concede" : "claim",
        runner: fields.get("runner"),
        createdAt: fields.get("ts") ?? comment.createdAt,
      });
    }
  }
  return out;
}

function danglingClaims(issue: ClaimHygieneIssueInput): DanglingClaim[] {
  const latestByOwner = new Map<string, GenericClaimMarker>();
  for (const marker of parseGenericClaimMarkers(issue)) {
    const key = `${marker.namespace}\0${marker.worker}`;
    const prev = latestByOwner.get(key);
    if (!prev || marker.commentId >= prev.commentId) latestByOwner.set(key, marker);
  }
  return [...latestByOwner.values()]
    .filter((marker) => marker.kind === "claim")
    .map((marker) => ({ issue: issue.number, marker }));
}

function classifyClaimHygiene(input: ClaimHygieneProbeInput, issues: readonly ClaimHygieneIssueInput[]): ClaimHygieneProbeData {
  const ownNamespace = (input.ownNamespace ?? "afk").toLowerCase();
  const actions: ClaimHygieneConcedeAction[] = [];
  const foreign: ClaimHygieneReportEntry[] = [];
  const unknown: ClaimHygieneReportEntry[] = [];
  let liveOwn = 0;
  let unknownOwn = 0;

  for (const issue of issues) {
    for (const claim of danglingClaims(issue)) {
      const marker = claim.marker;
      if (marker.namespace !== ownNamespace) {
        foreign.push({
          issue: claim.issue,
          markerComment: marker.commentId,
          namespace: marker.namespace,
          worker: marker.worker,
        });
        continue;
      }
      const pidState = input.workerPidState(marker.worker);
      if (pidState === "dead") {
        actions.push({
          issue: claim.issue,
          markerComment: marker.commentId,
          namespace: marker.namespace,
          worker: marker.worker,
          runner: marker.runner,
          pidState,
        });
      } else if (pidState === "live") {
        liveOwn += 1;
      } else if (
        input.nowS !== undefined &&
        classifyClaim(
          { createdAt: marker.createdAt } as ClaimRecord,
          input.nowS,
          input.staleness ?? DEFAULT_CLAIM_STALENESS,
        ) === "stale"
      ) {
        // Unknown pid BUT the marker aged past the ADR 0066 TTL window: the
        // owner stopped refreshing long enough to be presumed dead, so the
        // claim is concedable without ever proving the pid (#2525). Unknown-pid
        // ghosts stop red-halting boots once their TTL runs out.
        actions.push({
          issue: claim.issue,
          markerComment: marker.commentId,
          namespace: marker.namespace,
          worker: marker.worker,
          runner: marker.runner,
          pidState: "expired",
        });
      } else {
        unknownOwn += 1;
        unknown.push({
          issue: claim.issue,
          markerComment: marker.commentId,
          namespace: marker.namespace,
          worker: marker.worker,
        });
      }
    }
  }

  return { actions, foreign, unknown, liveOwn, unknownOwn };
}

function actionEvidence(actions: readonly ClaimHygieneConcedeAction[]): string {
  return actions
    .map(
      (action) =>
        `issue=#${action.issue} marker_comment=${action.markerComment} namespace=${action.namespace} worker=${action.worker} pid=${action.pidState}`,
    )
    .join("; ");
}

function evidence(data: ClaimHygieneProbeData): string {
  const parts: string[] = [];
  if (data.actions.length > 0) parts.push(actionEvidence(data.actions));
  if (data.foreign.length > 0) {
    parts.push(
      data.foreign
        .map(
          (entry) =>
            `issue=#${entry.issue} marker_comment=${entry.markerComment} foreign_namespace=${entry.namespace} worker=${entry.worker}`,
        )
        .join("; "),
    );
  }
  if (data.liveOwn > 0) parts.push(`live_own=${data.liveOwn}`);
  if (data.unknownOwn > 0) parts.push(`unknown_own=${data.unknownOwn}`);
  return parts.length > 0 ? parts.join("; ") : "no dangling claim markers found";
}

export async function runClaimHygieneProbe(context: OperationalProbeContext): Promise<OperationalProbeResult> {
  const input = context.claimHygiene;
  if (!input) {
    return {
      id: CLAIM_HYGIENE_PROBE_ID,
      name: CLAIM_HYGIENE_PROBE_NAME,
      verdict: "ok",
      evidence: "claim hygiene check not configured",
      canonicalFix: CLAIM_HYGIENE_CANONICAL_FIX,
    };
  }

  const issues = await input.listOpenQueueIssues();
  const data = classifyClaimHygiene(input, issues);
  const hasFinding = data.actions.length > 0 || data.foreign.length > 0 || data.unknownOwn > 0;
  return {
    id: CLAIM_HYGIENE_PROBE_ID,
    name: CLAIM_HYGIENE_PROBE_NAME,
    verdict: hasFinding ? "red" : "ok",
    evidence: evidence(data),
    canonicalFix: CLAIM_HYGIENE_CANONICAL_FIX,
    fix: data.actions.length > 0
      ? {
          gate: "confirm",
          description: "post matching concede markers for dead own-namespace workers",
        }
      : undefined,
    data,
  };
}

function claimHygieneData(finding: OperationalProbeResult): ClaimHygieneProbeData | undefined {
  const data = finding.data;
  if (!data || typeof data !== "object") return undefined;
  const rec = data as Partial<ClaimHygieneProbeData>;
  if (!Array.isArray(rec.actions) || !Array.isArray(rec.foreign)) return undefined;
  return rec as ClaimHygieneProbeData;
}

/**
 * The claim-hygiene finding's data when it is SAFE to auto-heal at boot: PURELY
 * dead own-namespace danglers (this machine's own dead-pid workers), with no
 * foreign markers and no unknown-pid own markers that a human must adjudicate.
 * Returns null otherwise. A boot sweep may auto-concede these without an
 * operator, so one stranded claim never throws BootHaltError and kills the
 * whole fleet (#2321).
 */
export function autoHealableClaimHygiene(finding: OperationalProbeResult): ClaimHygieneProbeData | null {
  const data = claimHygieneData(finding);
  if (!data || data.actions.length === 0) return null;
  if (data.foreign.length > 0 || data.unknownOwn > 0) return null;
  return data;
}

function groupActionsByIssue(actions: readonly ClaimHygieneConcedeAction[]): ClaimHygieneConcedeAction[][] {
  const byIssue = new Map<number, ClaimHygieneConcedeAction[]>();
  for (const action of actions) {
    const list = byIssue.get(action.issue) ?? [];
    list.push(action);
    byIssue.set(action.issue, list);
  }
  return [...byIssue.values()];
}

export async function applyClaimHygieneFix(
  finding: OperationalProbeResult,
  deps: OperationalProbeFixDeps,
): Promise<OperationalProbeFixResult> {
  const data = claimHygieneData(finding);
  if (!data || data.actions.length === 0) {
    return {
      probeId: finding.id,
      status: "noop",
      evidence: "no dead own-namespace dangling claims need repair",
    };
  }
  if (!deps.concedeClaim) {
    return { probeId: finding.id, status: "noop", evidence: "claim concede repair is not wired" };
  }

  let posted = 0;
  let declined = 0;
  for (const actions of groupActionsByIssue(data.actions)) {
    const issueFinding: OperationalProbeResult = {
      ...finding,
      evidence: actionEvidence(actions),
      data: { actions, foreign: [], unknown: [], liveOwn: 0, unknownOwn: 0 } satisfies ClaimHygieneProbeData,
    };
    if (!(await deps.confirm(issueFinding))) {
      declined += 1;
      continue;
    }
    for (const action of actions) {
      await deps.concedeClaim(
        action.issue,
        renderClaimComment({ worker: action.worker, runner: action.runner }, "concede"),
      );
      posted += 1;
    }
  }

  if (posted === 0 && declined > 0) {
    return { probeId: finding.id, status: "declined", evidence: `operator declined ${declined} issue repair` };
  }
  return {
    probeId: finding.id,
    status: posted > 0 ? "applied" : "noop",
    evidence: posted === 1 ? "posted 1 concede marker" : `posted ${posted} concede markers`,
  };
}

export const claimHygieneProbe: OperationalProbe = {
  id: CLAIM_HYGIENE_PROBE_ID,
  name: CLAIM_HYGIENE_PROBE_NAME,
  canonicalFix: CLAIM_HYGIENE_CANONICAL_FIX,
  run: runClaimHygieneProbe,
  applyFix: applyClaimHygieneFix,
};
