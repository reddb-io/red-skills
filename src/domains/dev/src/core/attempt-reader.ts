export type AttemptOutcomeKind = "done" | "blocked" | "no_more_tasks";

export interface AttemptOutcome {
  kind: AttemptOutcomeKind;
  raw: string;
}

const sentinelPattern = /<promise>\s*(DONE|BLOCKED|NO MORE TASKS)\s*<\/promise>/i;

export function detectSentinelLine(line: string): AttemptOutcome | null {
  const match = line.match(sentinelPattern);
  if (!match) return null;
  const normalized = match[1]!.toUpperCase();
  if (normalized === "DONE") return { kind: "done", raw: match[0] };
  if (normalized === "BLOCKED") return { kind: "blocked", raw: match[0] };
  return { kind: "no_more_tasks", raw: match[0] };
}

export function detectSentinelInText(text: string): AttemptOutcome | null {
  for (const line of text.split(/\r?\n/)) {
    const outcome = detectSentinelLine(line);
    if (outcome) return outcome;
  }
  return null;
}
