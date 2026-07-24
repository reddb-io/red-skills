export type WorkerOutcomeKind = "done" | "blocked" | "no_more_tasks";

export interface WorkerOutcome {
  kind: WorkerOutcomeKind;
  raw: string;
}

export const DONE_SIGNAL = "<promise>DONE</promise>";
export const BLOCKED_SIGNAL = "<promise>BLOCKED</promise>";
export const NO_MORE_TASKS_SIGNAL = "<promise>NO MORE TASKS</promise>";
export const COMPLETION_SIGNALS: readonly string[] = [DONE_SIGNAL, BLOCKED_SIGNAL];

const sentinelPattern = /<promise>\s*(DONE|BLOCKED|NO MORE TASKS)\s*<\/promise>/i;

export function detectSentinelLine(line: string): WorkerOutcome | null {
  const match = line.match(sentinelPattern);
  if (!match) return null;
  const normalized = match[1]!.toUpperCase();
  if (normalized === "DONE") return { kind: "done", raw: match[0] };
  if (normalized === "BLOCKED") return { kind: "blocked", raw: match[0] };
  return { kind: "no_more_tasks", raw: match[0] };
}

export function detectSentinelInText(text: string): WorkerOutcome | null {
  for (const line of text.split(/\r?\n/)) {
    const outcome = detectSentinelLine(line);
    if (outcome) return outcome;
  }
  return null;
}
