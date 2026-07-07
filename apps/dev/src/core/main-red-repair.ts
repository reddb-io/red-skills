import { LABEL_BUG, LABEL_READY, LABEL_URGENT } from "./triage-labels.js";

export const MAIN_RED_REPAIR_TITLE = "main-red repair: baseline probe failures on main";
export const MAIN_RED_REPAIR_MARKER = "<!-- red-skills:main-red-repair v1 -->";

export interface MainRedRepairIssue {
  number: number;
  title?: string;
  body?: string;
  labels?: readonly string[];
}

export type MainRedRepairPlan =
  | { action: "noop" }
  | { action: "create"; title: string; body: string; labels: readonly string[] }
  | { action: "update"; issue: number; title: string; body: string; labels: readonly string[] }
  | { action: "close"; issue: number; comment: string };

export type MainRedAdminMergeDecision = { ok: true } | { ok: false; message: string };

export function normalizeBaselineFailures(failures: readonly string[]): string[] {
  return [...new Set(failures.map((f) => f.trim()).filter((f) => f.length > 0))].sort();
}

export function renderMainRedRepairBody(failures: readonly string[]): string {
  const normalized = normalizeBaselineFailures(failures);
  const list = normalized.map((failure) => `- ${failure}`).join("\n");
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
    "## Source",
    "",
    "Auto-filed by the AFK feedback baseline probe.",
  ].join("\n");
}

export function planMainRedRepair(
  baselineFailures: readonly string[],
  currentOpenIssue: MainRedRepairIssue | null,
): MainRedRepairPlan {
  const failures = normalizeBaselineFailures(baselineFailures);
  if (failures.length === 0) {
    if (!currentOpenIssue) return { action: "noop" };
    return {
      action: "close",
      issue: currentOpenIssue.number,
      comment: "🤖 /afk baseline probe: main is green again; closing the auto-filed repair issue.",
    };
  }

  const body = renderMainRedRepairBody(failures);
  const labels = [LABEL_READY, LABEL_URGENT, LABEL_BUG];
  if (!currentOpenIssue) {
    return { action: "create", title: MAIN_RED_REPAIR_TITLE, body, labels };
  }
  return {
    action: "update",
    issue: currentOpenIssue.number,
    title: MAIN_RED_REPAIR_TITLE,
    body,
    labels,
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
