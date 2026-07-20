import { LABEL_BUG, LABEL_READY, LABEL_URGENT } from "./triage-labels.js";

export const MAIN_RED_REPAIR_TITLE = "main-red repair: baseline probe failures on main";
export const MAIN_RED_REPAIR_MARKER = "<!-- red-skills:main-red-repair v1 -->";

export interface MainRedRepairIssue {
  number: number;
  title?: string;
  body?: string;
  labels?: readonly string[];
}

export interface BaselineFailureEvidence {
  check: string;
  summary: string;
  outputTail: string;
}

export interface MainRedRepairObservation {
  sha: string;
  failures: readonly BaselineFailureEvidence[];
}

export type MainRedRepairPlan =
  | { action: "noop" }
  | { action: "create"; title: string; body: string; labels: readonly string[] }
  | { action: "comment"; issue: number; comment: string }
  | { action: "close"; issue: number; comment: string };

export type MainRedAdminMergeDecision = { ok: true } | { ok: false; message: string };

export function normalizeBaselineFailures(failures: readonly string[]): string[] {
  return [...new Set(failures.map((f) => f.trim()).filter((f) => f.length > 0))].sort();
}

const MAX_FAILURE_OUTPUT_LINES = 20;
const MAX_FAILURE_OUTPUT_CHARS = 4_000;

function boundedOutputTail(output: string): string {
  const lines = output.replace(/\n+$/, "").split("\n").slice(-MAX_FAILURE_OUTPUT_LINES);
  return lines.join("\n").slice(-MAX_FAILURE_OUTPUT_CHARS);
}

function normalizeEvidence(failures: readonly BaselineFailureEvidence[]): BaselineFailureEvidence[] {
  const byCheck = new Map<string, BaselineFailureEvidence>();
  for (const failure of failures) {
    const check = failure.check.trim();
    if (check === "" || byCheck.has(check)) continue;
    byCheck.set(check, {
      check,
      summary: failure.summary.trim() || "command exited non-zero",
      outputTail: boundedOutputTail(failure.outputTail),
    });
  }
  return [...byCheck.values()].sort((a, b) => a.check.localeCompare(b.check));
}

function renderIndentedOutput(output: string): string {
  if (output === "") return "    (no captured output)";
  return output.split("\n").map((line) => `    ${line}`).join("\n");
}

export function renderMainRedRepairObservation(observation: MainRedRepairObservation): string {
  const failures = normalizeEvidence(observation.failures);
  const sha = observation.sha.trim().slice(0, 64) || "(unresolved)";
  const evidence = failures.flatMap((failure) => [
    `### ${failure.check}`,
    "",
    `Failure: ${failure.summary}`,
    "",
    "Bounded output tail:",
    "",
    renderIndentedOutput(failure.outputTail),
    "",
  ]);
  return [
    `## Observation at ${sha}`,
    "",
    `Evaluated commit: \`${sha}\``,
    "",
    ...evidence,
  ].join("\n").replace(/\n+$/, "");
}

export function renderMainRedRepairBody(observation: MainRedRepairObservation): string {
  const normalized = normalizeEvidence(observation.failures);
  const list = normalized.map((failure) => `- ${failure.check}`).join("\n");
  return [
    MAIN_RED_REPAIR_MARKER,
    "",
    "## Summary",
    "",
    "The AFK feedback baseline probe found pre-existing failures on main. Repair main before relying on the feedback gate as a branch verdict.",
    "",
    "## Failing checks",
    "",
    list || "- (none)",
    "",
    renderMainRedRepairObservation({ ...observation, failures: normalized }),
    "",
    "## Source",
    "",
    "Auto-filed by the AFK feedback baseline probe.",
  ].join("\n");
}

export function mainRedRepairFailuresFromBody(body: string | undefined): string[] {
  if (!body || !body.includes(MAIN_RED_REPAIR_MARKER)) return [];
  const section = body.match(/(?:^|\n)## Failing checks\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
  return normalizeBaselineFailures(
    section
      .split("\n")
      .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? "")
      .filter((failure) => failure !== "" && failure !== "(none)"),
  );
}

function sameFailures(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizeBaselineFailures(left);
  const b = normalizeBaselineFailures(right);
  return a.length === b.length && a.every((failure, index) => failure === b[index]);
}

export function selectMainRedRepairIssue(
  issues: readonly MainRedRepairIssue[],
  failures: readonly string[],
): MainRedRepairIssue | null {
  return issues
    .filter((issue) => issue.body?.includes(MAIN_RED_REPAIR_MARKER))
    .filter((issue) => sameFailures(mainRedRepairFailuresFromBody(issue.body), failures))
    .sort((a, b) => a.number - b.number)[0] ?? null;
}

export function planMainRedRepair(
  observation: MainRedRepairObservation,
  currentOpenIssue: MainRedRepairIssue | null,
): MainRedRepairPlan {
  const failures = normalizeEvidence(observation.failures);
  if (failures.length === 0) {
    if (!currentOpenIssue) return { action: "noop" };
    return {
      action: "close",
      issue: currentOpenIssue.number,
      comment: "🤖 /afk baseline probe: main is green again; closing the auto-filed repair issue.",
    };
  }

  const body = renderMainRedRepairBody({ ...observation, failures });
  const labels = [LABEL_READY, LABEL_URGENT, LABEL_BUG];
  if (
    !currentOpenIssue ||
    !sameFailures(mainRedRepairFailuresFromBody(currentOpenIssue.body), failures.map((failure) => failure.check))
  ) {
    return { action: "create", title: MAIN_RED_REPAIR_TITLE, body, labels };
  }
  return {
    action: "comment",
    issue: currentOpenIssue.number,
    comment: renderMainRedRepairObservation({ ...observation, failures }),
  };
}

export function decideMainRedAdminMerge(input: {
  mainRed: boolean;
  openRepairIssue: MainRedRepairIssue | null;
}): MainRedAdminMergeDecision {
  if (!input.mainRed) return { ok: true };
  if (input.openRepairIssue) return { ok: true };

  return {
    ok: false,
    message:
      "Refusing admin-merge onto red main because no open main-red repair issue exists. " +
      `Restore the tracked-red visibility gate by letting syncMainRedRepairIssue auto-file "${MAIN_RED_REPAIR_TITLE}" ` +
      "from the AFK feedback baseline probe before landing.",
  };
}
