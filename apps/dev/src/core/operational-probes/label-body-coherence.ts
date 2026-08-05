import {
  appendQuarantineDiagnosis,
  clearCurrentBlocker,
  parseCurrentBlocker,
  quarantineMarker,
  type CurrentBlocker,
} from "../blocker-state.js";
import { LABEL_READY } from "../triage-labels.js";
import type {
  LabelBodyCoherenceIssueInput,
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeResult,
} from "./types.js";

export const LABEL_BODY_COHERENCE_PROBE_ID = "afk.label-body-coherence";
export const LABEL_BODY_COHERENCE_PROBE_NAME = "AFK label/body coherence";
export const LABEL_BODY_COHERENCE_CANONICAL_FIX =
  "For ready-for-agent issues whose body still carries an active Current blocker, confirm per issue and archive the blocker into Resolved blockers while clearing Current blocker to None.";

export interface LabelBodyCoherenceAction {
  readonly issue: number;
  readonly labels: readonly string[];
  readonly blocker: CurrentBlocker;
  readonly body: string;
}

export interface LabelBodyCoherenceProbeData {
  readonly actions: readonly LabelBodyCoherenceAction[];
}

function classifyIssues(issues: readonly LabelBodyCoherenceIssueInput[]): LabelBodyCoherenceProbeData {
  const actions: LabelBodyCoherenceAction[] = [];
  for (const issue of issues) {
    if (!issue.labels.includes(LABEL_READY)) continue;
    const blocker = parseCurrentBlocker(issue.body);
    if (!blocker) continue;
    actions.push({
      issue: issue.number,
      labels: issue.labels,
      blocker,
      body: issue.body,
    });
  }
  return { actions };
}

function labelText(labels: readonly string[]): string {
  return labels.length > 0 ? labels.join(",") : "(none)";
}

function blockerEvidence(action: LabelBodyCoherenceAction): string {
  const ref = action.blocker.ref ? ` ref=${action.blocker.ref}` : "";
  return [
    `issue=#${action.issue}`,
    `labels=[${labelText(action.labels)}]`,
    `blocker={status=blocked kind=${action.blocker.kind}${ref} summary=${JSON.stringify(action.blocker.summary)} next=${JSON.stringify(action.blocker.next)}}`,
  ].join(" ");
}

function evidence(data: LabelBodyCoherenceProbeData): string {
  if (data.actions.length === 0) return "no ready-for-agent issues carry an active Current blocker";
  return data.actions.map(blockerEvidence).join("; ");
}

export async function runLabelBodyCoherenceProbe(context: OperationalProbeContext): Promise<OperationalProbeResult> {
  const input = context.labelBodyCoherence;
  if (!input) {
    return {
      id: LABEL_BODY_COHERENCE_PROBE_ID,
      name: LABEL_BODY_COHERENCE_PROBE_NAME,
      verdict: "ok",
      evidence: "label/body coherence check not configured",
      canonicalFix: LABEL_BODY_COHERENCE_CANONICAL_FIX,
    };
  }

  const data = classifyIssues(await input.listOpenReadyIssues());
  return {
    id: LABEL_BODY_COHERENCE_PROBE_ID,
    name: LABEL_BODY_COHERENCE_PROBE_NAME,
    verdict: data.actions.length > 0 ? "red" : "ok",
    evidence: evidence(data),
    canonicalFix: LABEL_BODY_COHERENCE_CANONICAL_FIX,
    fix: data.actions.length > 0
      ? {
          gate: "confirm",
          description: "archive active Current blockers on ready-for-agent issues",
        }
      : undefined,
    data,
  };
}

function labelBodyCoherenceData(finding: OperationalProbeResult): LabelBodyCoherenceProbeData | undefined {
  const data = finding.data;
  if (!data || typeof data !== "object") return undefined;
  const rec = data as Partial<LabelBodyCoherenceProbeData>;
  if (!Array.isArray(rec.actions)) return undefined;
  return rec as LabelBodyCoherenceProbeData;
}

export function buildLabelBodyCoherenceQuarantineComment(action: LabelBodyCoherenceAction): string {
  const ref = action.blocker.ref ? ` ref=${action.blocker.ref}` : "";
  return [
    quarantineMarker(action.issue),
    `🤖 /afk coherence probe quarantined this issue: it carried \`ready-for-agent\` while the body still contained an active \`Current blocker\`.`,
    ``,
    `**Incoherence:** labels=\`[${action.labels.join(",")}]\` body-blocker=\`{kind=${action.blocker.kind}${ref} summary=${JSON.stringify(action.blocker.summary)}}\``,
    ``,
    `**Fix recipe:** Archive or clear the \`## Current blocker\` section in the body, then restore \`ready-for-agent\`.`,
  ].join("\n");
}

/** Append the issue-local ADR 0122 diagnosis without rewriting the operator's
 * existing body. The marker makes retries idempotent even when a prior label
 * mutation failed after the body write. */
export function appendLabelBodyCoherenceQuarantineDiagnosis(action: LabelBodyCoherenceAction): string {
  return appendQuarantineDiagnosis(
    action.body,
    action.issue,
    buildLabelBodyCoherenceQuarantineComment(action),
  );
}

function archiveBody(action: LabelBodyCoherenceAction): string {
  return clearCurrentBlocker(action.body, {
    summary: action.blocker.summary,
    resolution: "ready-for-agent label confirmed; active blocker archived by gated repair.",
  });
}

export async function applyLabelBodyCoherenceFix(
  finding: OperationalProbeResult,
  deps: OperationalProbeFixDeps,
): Promise<OperationalProbeFixResult> {
  const data = labelBodyCoherenceData(finding);
  if (!data || data.actions.length === 0) {
    return {
      probeId: finding.id,
      status: "noop",
      evidence: "no active ready-labelled blockers need repair",
    };
  }
  if (!deps.updateIssueBody) {
    return { probeId: finding.id, status: "noop", evidence: "issue body repair is not wired" };
  }

  let applied = 0;
  let declined = 0;
  for (const action of data.actions) {
    const issueFinding: OperationalProbeResult = {
      ...finding,
      evidence: blockerEvidence(action),
      data: { actions: [action] } satisfies LabelBodyCoherenceProbeData,
    };
    if (!(await deps.confirm(issueFinding))) {
      declined += 1;
      continue;
    }
    const nextBody = archiveBody(action);
    if (nextBody !== action.body) {
      await deps.updateIssueBody(action.issue, nextBody);
      applied += 1;
    }
  }

  if (applied === 0 && declined > 0) {
    return { probeId: finding.id, status: "declined", evidence: `operator declined ${declined} issue repair` };
  }
  return {
    probeId: finding.id,
    status: applied > 0 ? "applied" : "noop",
    evidence: applied === 1 ? "archived 1 active blocker" : `archived ${applied} active blockers`,
  };
}

export const labelBodyCoherenceProbe: OperationalProbe = {
  id: LABEL_BODY_COHERENCE_PROBE_ID,
  name: LABEL_BODY_COHERENCE_PROBE_NAME,
  canonicalFix: LABEL_BODY_COHERENCE_CANONICAL_FIX,
  run: runLabelBodyCoherenceProbe,
  applyFix: applyLabelBodyCoherenceFix,
};
