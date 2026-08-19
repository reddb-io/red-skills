import type { EngineLabelVocabulary } from "../config.js";
import { isRefused, planTransition } from "../state-transition.js";
import type { TrackerIssue, TrackerPort, TrackerIssueReference } from "./port.js";

export type { TrackerIssue, TrackerPort, TrackerIssueReference } from "./port.js";

const BLOCKED_BY_HEADING_RE = /^## Blocked by[ \t]*$/;
const ANY_H2_RE = /^## /;
const REF_TOKEN_RE = /#[0-9]+/g;

export function labelForDependency(issue: number, labels: EngineLabelVocabulary): string {
  return `${labels.reqPrefix}${issue}`;
}

function dependencyLabelPattern(labels: EngineLabelVocabulary): RegExp {
  return new RegExp(`^${escapeRegExp(labels.reqPrefix)}([0-9]+)$`);
}

export function parseDependencyLabels(issueLabels: readonly string[], labels: EngineLabelVocabulary): number[] {
  const pattern = dependencyLabelPattern(labels);
  const seen = new Set<number>();
  for (const label of issueLabels) {
    const match = pattern.exec(label.trim());
    if (match) seen.add(Number(match[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

export function parseBlockedBy(body: string): number[] {
  let inSection = false;
  const seen = new Set<number>();
  for (const line of body.split("\n")) {
    if (inSection) {
      if (ANY_H2_RE.test(line)) {
        inSection = false;
        continue;
      }
      const matches = line.match(REF_TOKEN_RE);
      if (matches) for (const ref of matches) seen.add(Number(ref.slice(1)));
      continue;
    }
    if (BLOCKED_BY_HEADING_RE.test(line)) inSection = true;
  }
  return [...seen].sort((a, b) => a - b);
}

export interface DependencyPromotionPlan {
  readonly issue: number;
  readonly dependencies: readonly number[];
  readonly removeLabels: readonly string[];
  readonly addLabels: readonly string[];
}

export interface ExecuteCloseCascadeOptions {
  readonly closedIssue: number;
  readonly tracker: TrackerPort;
  readonly labels: EngineLabelVocabulary;
}

export interface ExecuteUnblockSweepOptions {
  readonly tracker: TrackerPort;
  readonly labels: EngineLabelVocabulary;
}

export async function executeCloseCascade(options: ExecuteCloseCascadeOptions): Promise<number[]> {
  const dependencyLabel = labelForDependency(options.closedIssue, options.labels);
  const dependents = await options.tracker.listOpenIssuesByLabel(dependencyLabel);
  return executePromotions(
    options.tracker,
    options.labels,
    await planPromotions(dependents, options.tracker, options.labels, options.closedIssue),
  );
}

export async function executeUnblockSweep(options: ExecuteUnblockSweepOptions): Promise<number[]> {
  const candidates = await options.tracker.listOpenIssuesByLabel(options.labels.dependencyBlocked);
  return executePromotions(
    options.tracker,
    options.labels,
    await planPromotions(candidates, options.tracker, options.labels),
  );
}

async function planPromotions(
  candidates: readonly TrackerIssue[],
  tracker: TrackerPort,
  labels: EngineLabelVocabulary,
  justClosedIssue?: number,
): Promise<DependencyPromotionPlan[]> {
  const plans: DependencyPromotionPlan[] = [];
  for (const candidate of candidates) {
    if (!candidate.labels.includes(labels.dependencyBlocked)) continue;

    const labelDeps = parseDependencyLabels(candidate.labels, labels);
    const dependencies = labelDeps.length > 0 ? labelDeps : parseBlockedBy(candidate.body);
    if (dependencies.length === 0) continue;

    let allClosed = true;
    for (const dependency of dependencies) {
      if (dependency === justClosedIssue) continue;
      if (!(await tracker.isIssueClosed(dependency))) {
        allClosed = false;
        break;
      }
    }
    if (!allClosed) continue;

    // The DECISION above is this module's; the WRITE is the transition API's —
    // `promote` consumes the `req:*` edges and re-queues in one proven-coherent
    // mutation (#2666, ADR 0122 rule 5).
    const transition = planTransition(candidate.labels, { kind: "promote" }, labels);
    if (isRefused(transition)) continue;

    plans.push({
      issue: candidate.number,
      dependencies,
      removeLabels: transition.remove,
      addLabels: transition.add,
    });
  }
  return plans;
}

async function executePromotions(
  tracker: TrackerPort,
  labels: EngineLabelVocabulary,
  plans: readonly DependencyPromotionPlan[],
): Promise<number[]> {
  const promoted: number[] = [];
  for (const plan of plans) {
    await tracker.editIssueLabels(plan.issue, {
      remove: [...plan.removeLabels],
      add: [...plan.addLabels],
    });
    await tracker.commentOnIssue(plan.issue, await dependencyAuditComment(plan.dependencies, tracker.issueReference));
    promoted.push(plan.issue);
  }
  return promoted;
}

async function dependencyAuditComment(
  dependencies: readonly number[],
  lookup?: TrackerPort["issueReference"],
): Promise<string> {
  const refs = await Promise.all(
    dependencies.map(async (number) => (await lookup?.(number)) ?? { number }),
  );
  return `🤖 /afk unblocked: all dependencies closed (${refs.map(renderIssueReference).join(", ")}).`;
}

function renderIssueReference(ref: TrackerIssueReference): string {
  const plain = `#${ref.number}`;
  if (!ref.title || !ref.url) return plain;
  return `[${ref.title} (${plain})](${ref.url})`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
