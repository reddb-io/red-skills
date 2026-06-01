// blocker-state - machine-readable issue-body state for the active HITL/AFK
// blocker. This is the durable handoff between `/afk` and `/hitl`: labels route
// the issue, comments preserve audit history, and this block says what still
// needs to be resolved before an agent can continue.

export const BLOCKER_HEADING = "Current blocker";
export const RESOLVED_BLOCKERS_HEADING = "Resolved blockers";
export const BLOCKER_OPEN = "<!-- red:blocker-state v1 -->";
export const BLOCKER_CLOSE = "<!-- /red:blocker-state -->";

export interface CurrentBlocker {
  status: "blocked";
  kind: string;
  ref?: string;
  summary: string;
  next: string;
}

export interface ResolvedBlocker {
  summary: string;
  resolution: string;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstLine(value: string): string {
  return normalizeLine(value.split("\n").find((line) => normalizeLine(line).length > 0) ?? "");
}

function safeField(value: string | undefined, fallback = ""): string {
  const line = normalizeLine(value ?? "");
  return line.length > 0 ? line : fallback;
}

function parseFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export function parseCurrentBlocker(markdown: string): CurrentBlocker | null {
  const start = markdown.indexOf(BLOCKER_OPEN);
  if (start === -1) return null;
  const bodyStart = start + BLOCKER_OPEN.length;
  const end = markdown.indexOf(BLOCKER_CLOSE, bodyStart);
  if (end === -1) return null;
  const fields = parseFields(markdown.slice(bodyStart, end));
  if (fields.status !== "blocked") return null;
  const summary = safeField(fields.summary);
  const next = safeField(fields.next);
  if (!summary || !next) return null;
  return {
    status: "blocked",
    kind: safeField(fields.kind, "unknown"),
    ...(fields.ref ? { ref: safeField(fields.ref) } : {}),
    summary,
    next,
  };
}

export function formatCurrentBlocker(blocker: CurrentBlocker): string {
  const lines = [
    BLOCKER_OPEN,
    `status: ${blocker.status}`,
    `kind: ${safeField(blocker.kind, "unknown")}`,
  ];
  if (blocker.ref) lines.push(`ref: ${safeField(blocker.ref)}`);
  lines.push(`summary: ${safeField(blocker.summary, "Unspecified blocker.")}`);
  lines.push(`next: ${safeField(blocker.next, "Human guidance required.")}`);
  lines.push(BLOCKER_CLOSE);
  return lines.join("\n");
}

function currentBlockerSectionRange(markdown: string): { start: number; end: number } | null {
  const lines = markdown.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (new RegExp(`^##\\s+${BLOCKER_HEADING}\\s*$`, "i").test(line.trim())) {
      const start = offset;
      let end = markdown.length;
      let innerOffset = offset + line.length + 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]!;
        if (/^##\s+/.test(next)) {
          end = innerOffset;
          break;
        }
        innerOffset += next.length + 1;
      }
      return { start, end };
    }
    offset += line.length + 1;
  }
  return null;
}

export function upsertCurrentBlocker(markdown: string, blocker: CurrentBlocker): string {
  const replacement = `## ${BLOCKER_HEADING}\n\n${formatCurrentBlocker(blocker)}\n`;
  const range = currentBlockerSectionRange(markdown);
  if (range) {
    return `${markdown.slice(0, range.start)}${replacement}\n${markdown.slice(range.end).trimStart()}`.trimEnd() + "\n";
  }
  const prefix = markdown.trimEnd();
  return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${replacement}`;
}

function appendResolvedBlocker(markdown: string, resolved: ResolvedBlocker): string {
  const entry = `- [x] ${safeField(resolved.summary, "Resolved blocker.")} - ${safeField(
    firstLine(resolved.resolution),
    "resolved",
  )}`;
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^##\\s+${RESOLVED_BLOCKERS_HEADING}\\s*$`, "i");
  const idx = lines.findIndex((line) => headingRe.test(line.trim()));
  if (idx === -1) {
    const prefix = markdown.trimEnd();
    return `${prefix}${prefix.length > 0 ? "\n\n" : ""}## ${RESOLVED_BLOCKERS_HEADING}\n\n${entry}\n`;
  }
  const existing = lines.slice(idx + 1).filter((line, i) => i !== 0 || line.trim() !== "");
  const next = [...lines.slice(0, idx + 1), "", entry, ...existing];
  return `${next.join("\n").trimEnd()}\n`;
}

export function clearCurrentBlocker(markdown: string, resolved?: ResolvedBlocker): string {
  const active = parseCurrentBlocker(markdown);
  const replacement = `## ${BLOCKER_HEADING}\n\nNone\n`;
  const range = currentBlockerSectionRange(markdown);
  let next = markdown;
  if (range) {
    next = `${markdown.slice(0, range.start)}${replacement}\n${markdown.slice(range.end).trimStart()}`.trimEnd() + "\n";
  } else {
    const start = markdown.indexOf(BLOCKER_OPEN);
    const end = start === -1 ? -1 : markdown.indexOf(BLOCKER_CLOSE, start + BLOCKER_OPEN.length);
    if (start !== -1 && end !== -1) {
      next = `${markdown.slice(0, start)}${markdown.slice(end + BLOCKER_CLOSE.length)}`.trimEnd() + "\n";
    }
  }
  if (!resolved || !active) return next;
  return appendResolvedBlocker(next, resolved);
}
