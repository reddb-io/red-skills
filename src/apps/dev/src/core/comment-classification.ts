// comment-classification — pure predicates and classifier over issue-comment
// bodies, ported from the bash classifier in afk.sh (PRD #29 #30).
//
// Every function here is a pure text predicate: no `gh`, no `jq`, no network,
// no filesystem. They are the single source of truth both the directive
// routing track and the per-issue BLOCKED cap state machine read from.
//
// The body-shape tests mirror the bash predicates exactly (see afk.sh
// `envelope_is_envelope`, `comment_is_boot_stamp`, `comment_is_promotion_audit`,
// `comment_is_heartbeat_glyph`, `classify_comment`, `extract_directives`,
// `_comment_is_directive_carrier`).

/** Discriminated category a comment body resolves to. */
export type CommentCategory =
  | "envelope"
  | "boot-stamp"
  | "promotion-audit"
  | "heartbeat-glyph"
  | "human-guidance"
  | "directive"
  | "discussion";

/** A comment body, used by the thread-level helpers. */
export interface Comment {
  body: string;
}

const ENVELOPE_OPEN = '<details data-attempt-status="';
const DIRECTIVE_OPEN = '<details data-kind="directive">';

/** True when the trimmed-of-all-whitespace body is empty (bash `${body//[[:space:]]/}`). */
function isBlank(body: string): boolean {
  return body.replace(/\s/g, "").length === 0;
}

/**
 * Envelope: the body starts with `<details data-attempt-status="` and contains
 * a `</details>` somewhere after. Mirrors `envelope_is_envelope`.
 */
export function isEnvelope(body: string): boolean {
  return body.startsWith(ENVELOPE_OPEN) && body.includes("</details>");
}

/** Boot stamp: orchestrator-authored start line. Mirrors `comment_is_boot_stamp`. */
export function isBootStamp(body: string): boolean {
  return body.startsWith("🤖 /afk started ");
}

/** Promotion audit line. Mirrors `comment_is_promotion_audit`. */
export function isPromotionAudit(body: string): boolean {
  return body.startsWith("🤖 /afk promoted to ready-for-agent");
}

/**
 * Legacy heartbeat glyph (`:one:` … `:six:`). All whitespace is stripped first,
 * then the remainder must equal exactly one glyph. Mirrors
 * `comment_is_heartbeat_glyph`.
 */
export function isHeartbeatGlyph(body: string): boolean {
  const trimmed = body.replace(/\s/g, "");
  return /^:(one|two|three|four|five|six):$/.test(trimmed);
}

/**
 * Human guidance: not blank, not an envelope, and not one of the orchestrator's
 * noise classes (boot stamp / promotion audit / heartbeat glyph). Mirrors
 * `comment_is_human_guidance`.
 */
export function isHumanGuidance(body: string): boolean {
  if (isBlank(body)) return false;
  if (isEnvelope(body)) return false;
  if (isBootStamp(body)) return false;
  if (isPromotionAudit(body)) return false;
  if (isHeartbeatGlyph(body)) return false;
  return true;
}

/**
 * Directive carrier (the narrow body-shape filter the cap state machine uses):
 * not blank, not envelope, not audit noise, contains the directive opening tag,
 * and a `</details>` appears after the first opening tag. This is a substring
 * peek — NOT the well-formed parse that {@link extractDirectives} performs.
 * Mirrors `_comment_is_directive_carrier`.
 */
export function isDirectiveCarrier(body: string): boolean {
  if (isBlank(body)) return false;
  if (isEnvelope(body)) return false;
  if (isBootStamp(body)) return false;
  if (isPromotionAudit(body)) return false;
  if (isHeartbeatGlyph(body)) return false;
  const openIdx = body.indexOf(DIRECTIVE_OPEN);
  if (openIdx === -1) return false;
  const after = body.slice(openIdx + DIRECTIVE_OPEN.length);
  return after.includes("</details>");
}

/**
 * Extract the verbatim text content of every well-formed
 * `<details data-kind="directive">…</details>` element in `body`, in document
 * order. Returns `[]` when no marker is present or only malformed markers exist.
 *
 * Line-oriented parsing contract (mirrors `extract_directives`):
 *   - The opening tag is recognised only as a whole trimmed line equal to
 *     `<details data-kind="directive">`.
 *   - Content is every line strictly between that open and its matching
 *     `</details>`, joined with `\n`, verbatim — including any nested
 *     `<details>` block.
 *   - Nesting: a trimmed line starting `<details` raises depth, a trimmed line
 *     exactly `</details>` lowers it; the directive ends only when depth
 *     returns to 0. A closing tag carrying attributes (`</details foo>`) is not
 *     a valid close.
 *   - Code fences: a trimmed line starting with ``` toggles a fence; inside a
 *     fence tag detection is suspended.
 *   - CRLF: a trailing `\r` is stripped from every line before matching.
 *   - Malformed (opened but never closed, or closed only with an attributed
 *     tag) yields no output for that element.
 */
export function extractDirectives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let fence = false;
  let content = "";

  for (let line of body.split("\n")) {
    // strip a trailing CR (CRLF line endings)
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (depth > 0) content += "\n" + line;
      fence = !fence;
      continue;
    }
    if (fence) {
      if (depth > 0) content += "\n" + line;
      continue;
    }

    if (depth === 0) {
      if (trimmed === DIRECTIVE_OPEN) {
        depth = 1;
        content = "";
      }
      continue;
    }

    if (trimmed.startsWith("<details")) {
      depth += 1;
      content += "\n" + line;
      continue;
    }
    if (trimmed === "</details>") {
      depth -= 1;
      if (depth === 0) {
        // drop the single leading "\n" accumulated before the first content line
        out.push(content.startsWith("\n") ? content.slice(1) : content);
        content = "";
      } else {
        content += "\n" + line;
      }
      continue;
    }
    content += "\n" + line;
  }

  return out;
}

/**
 * Classify a comment body into a single category. Precedence (first match wins),
 * mirroring `classify_comment`:
 *   1. blank body                                   → audit_noise
 *   2. `<details data-attempt-status="…">` envelope → envelope
 *   3. boot stamp / promotion audit / heartbeat     → audit_noise
 *   4. ≥1 well-formed directive marker              → directive
 *   5. anything else                                → discussion
 *
 * The bash classifier collapses blank + boot/promotion/heartbeat into a single
 * `audit_noise` token. Here those keep their distinct categories so callers can
 * tell them apart; blank maps to `discussion` (no audit class of its own), and
 * the noise predicates map to their named categories. The directive arm defers
 * to {@link extractDirectives} for well-formedness, exactly as the bash does.
 */
export function classifyComment(comment: Comment): CommentCategory {
  const body = comment.body;
  if (isBlank(body)) return "discussion";
  if (isEnvelope(body)) return "envelope";
  if (isBootStamp(body)) return "boot-stamp";
  if (isPromotionAudit(body)) return "promotion-audit";
  if (isHeartbeatGlyph(body)) return "heartbeat-glyph";
  if (extractDirectives(body).length > 0) return "directive";
  return "discussion";
}

/** The envelope's `data-attempt-status` value, or `undefined` when absent. */
export function envelopeStatus(body: string): string | undefined {
  const match = /data-attempt-status="([^"]*)"/.exec(body);
  return match ? match[1] : undefined;
}

/**
 * Count trailing consecutive BLOCKED envelopes, scanning newest → oldest, the
 * run broken by a non-blocked envelope or a directive-carrier comment. Audit
 * noise and discussion comments are skipped without resetting. Mirrors
 * `count_blocked_since_guidance`.
 */
export function countBlockedSinceGuidance(comments: Comment[]): number {
  let count = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]!.body;
    if (isEnvelope(body)) {
      if (envelopeStatus(body) === "blocked") {
        count += 1;
        continue;
      }
      // Non-blocked envelope breaks the trailing-BLOCKED run.
      break;
    }
    if (isDirectiveCarrier(body)) {
      break;
    }
    // audit noise or discussion — skip without resetting.
  }
  return count;
}

/**
 * True when the thread contains no directive-carrier comment at all — the
 * operator has never used the `<details data-kind="directive">` marker, so the
 * trip comment should teach the syntax. Mirrors `_thread_lacks_directive_marker`.
 */
export function threadLacksDirectiveMarker(comments: Comment[]): boolean {
  for (const comment of comments) {
    if (isDirectiveCarrier(comment.body)) return false;
  }
  return true;
}
