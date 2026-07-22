export {
  CARD_CLOSE,
  CARD_OPEN,
  CARD_STATUS_CLOSE,
  CARD_STATUS_OPEN,
  classifyNaturalLanguage,
  isHitlCard,
  parseCardCommand,
  parseCiChecks,
  postHitlCard,
  renderCard,
  updateCardStatus,
} from "@reddb-io/red-castle";
export type {
  CardAction,
  CardCommand,
  PrStatus,
  RenderCardOpts,
} from "@reddb-io/red-castle";

export const HITL_CARD_ACTION_MARKER = "<!-- red:hitl-card:action v1 -->";
export const HITL_CARD_STAND_DOWN_MARKER = "<!-- red:hitl-card:stand-down v1 -->";
export const HITL_CARD_ACTION_LIMIT = 3;
export const HITL_CARD_ACTION_WINDOW_MS = 10 * 60 * 1_000;

export interface HitlCardCommentSource {
  author?: string;
  authorType?: string;
  body: string;
}

/**
 * Reject automation before either slash-command or natural-language parsing.
 * GitHub's default token reports `Bot`, while a PAT can make the same workflow
 * reply look like a `User`; the login and stable outbound markers close those
 * two independent self-reaction paths.
 */
export function shouldIgnoreHitlCardComment(input: HitlCardCommentSource): boolean {
  const authorType = input.authorType?.trim().toLowerCase();
  if (authorType && authorType !== "user") return true;

  const author = input.author?.trim() ?? "";
  if (/\[bot\]$/i.test(author) || /^github-actions$/i.test(author)) return true;

  const body = input.body.trimStart();
  return [
    HITL_CARD_ACTION_MARKER,
    HITL_CARD_STAND_DOWN_MARKER,
    "<!-- red:hitl-card v1 -->",
    '<details data-kind="directive">',
    "🤖",
    "⛔",
    "⚠️",
  ].some((prefix) => body.startsWith(prefix));
}

export interface HitlCardActionComment {
  body: string;
  createdAt?: string;
}

export interface HitlCardActionRate {
  actionCount: number;
  limited: boolean;
  shouldPostStandDown: boolean;
}

/**
 * Count completed card actions in a rolling window. The legacy summary match
 * protects already-running installations while the v1 marker gives new action
 * receipts an exact, cheap identity.
 */
export function evaluateHitlCardActionRate(
  comments: readonly HitlCardActionComment[],
  now = new Date(),
): HitlCardActionRate {
  const cutoff = now.getTime() - HITL_CARD_ACTION_WINDOW_MS;
  let actionCount = 0;
  let hasStandDown = false;

  for (const comment of comments) {
    const createdAt = Date.parse(comment.createdAt ?? "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff || createdAt > now.getTime()) continue;
    if (
      comment.body.includes(HITL_CARD_ACTION_MARKER) ||
      comment.body.includes("<summary>HITL card:")
    ) {
      actionCount += 1;
    }
    if (comment.body.includes(HITL_CARD_STAND_DOWN_MARKER)) hasStandDown = true;
  }

  const limited = actionCount >= HITL_CARD_ACTION_LIMIT;
  return {
    actionCount,
    limited,
    shouldPostStandDown: limited && !hasStandDown,
  };
}
