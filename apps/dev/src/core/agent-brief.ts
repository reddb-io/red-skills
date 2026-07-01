// agent-brief - byte-exact anchored editing for the ## Agent brief section of
// issue bodies. Mirrors the blocker-state approach: a surgical anchor-based fast
// path preserves every byte outside the inner region on every subsequent edit;
// the fallback (no anchors yet) injects the anchors so the next edit is already
// byte-exact. This eliminates the whole-document whitespace normalisation that
// upsertMarkdownSection() introduced.

import { readAnchoredRegion, replaceAnchoredRegion } from "./anchored-edit.js";

export const AGENT_BRIEF_HEADING = "Agent brief";
export const AGENT_BRIEF_OPEN = "<!-- red:agent-brief v1 -->";
export const AGENT_BRIEF_CLOSE = "<!-- /red:agent-brief -->";

/** The inner content between the anchors: newline-padded brief text. */
function formatBriefInner(brief: string): string {
  return `\n${brief.trim()}\n`;
}

/** Find the byte range of the `## Agent brief` section (heading through the
 * start of the next ## heading, or the end of the document). */
function agentBriefSectionRange(markdown: string): { start: number; end: number } | null {
  const lines = markdown.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (new RegExp(`^##\\s+${AGENT_BRIEF_HEADING}\\s*$`, "i").test(line)) {
      const start = offset;
      let end = markdown.length;
      let innerOffset = offset + line.length + 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^##\s+/.test(lines[j]!)) {
          end = innerOffset;
          break;
        }
        innerOffset += lines[j]!.length + 1;
      }
      return { start, end };
    }
    offset += line.length + 1;
  }
  return null;
}

/**
 * Upsert the `## Agent brief` section using byte-exact anchor editing when the
 * anchors already exist (fast path). When the section exists but lacks anchors,
 * replaces it with an anchored block so subsequent edits are byte-exact. When
 * the section is absent, appends it.
 *
 * The anchored fast path calls `replaceAnchoredRegion`, which preserves every
 * byte outside the inner region unchanged — no trailing-whitespace normalisation
 * of the surrounding document.
 */
export function upsertAgentBrief(markdown: string, brief: string): string {
  const inner = formatBriefInner(brief);

  // Fast path: byte-exact replacement inside the existing anchored region.
  const anchored = replaceAnchoredRegion(markdown, AGENT_BRIEF_OPEN, AGENT_BRIEF_CLOSE, inner);
  if (anchored !== null) return anchored;

  // Fallback: no anchors yet — inject the anchored section, replacing the bare
  // heading block (if present) or appending. The next call takes the fast path.
  const replacement = `## ${AGENT_BRIEF_HEADING}\n\n${AGENT_BRIEF_OPEN}${inner}${AGENT_BRIEF_CLOSE}\n`;
  const range = agentBriefSectionRange(markdown);
  if (range) {
    return (
      `${markdown.slice(0, range.start)}${replacement}\n${markdown.slice(range.end).replace(/^\n+/, "")}`.trimEnd() +
      "\n"
    );
  }
  const prefix = markdown.trimEnd();
  return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${replacement}`;
}

export interface AgentBriefEditResult {
  /** The body after the surgical edit (byte-identical reference when no change). */
  body: string;
  /** True when the body differs from the input — a no-op is signaled by false. */
  changed: boolean;
  /** True when reading the result back yields the intended brief text (round-trip
   * integrity). A false `valid` means the anchors were malformed or the brief
   * could not be written; callers should skip the remote write. */
  valid: boolean;
}

/**
 * Byte-exact round-trip edit: compute the new body surgically, detect whether it
 * changed, and confirm the parse-back yields the intended brief. Callers can skip
 * the remote write when `changed` is false and trust the edit was correctly formed
 * when `valid` is true.
 */
export function applyAgentBriefEdit(markdown: string, brief: string): AgentBriefEditResult {
  const body = upsertAgentBrief(markdown, brief);
  const changed = body !== markdown;
  const read = readAnchoredRegion(body, AGENT_BRIEF_OPEN, AGENT_BRIEF_CLOSE);
  const valid = read !== null && read.trim() === brief.trim();
  return { body, changed, valid };
}
