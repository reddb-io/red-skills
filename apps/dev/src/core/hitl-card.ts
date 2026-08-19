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
} from "@reddb-io/worker";
export type {
  CardAction,
  CardCommand,
  PrStatus,
  RenderCardOpts,
} from "@reddb-io/worker";

export const HITL_CARD_ACTION_MARKER = "<!-- red:hitl-card:action v1 -->";
export const HITL_CARD_STAND_DOWN_MARKER = "<!-- red:hitl-card:stand-down v1 -->";
export const HITL_CARD_ACTION_LIMIT = 3;
export const HITL_CARD_ACTION_WINDOW_MS = 10 * 60 * 1_000;

export interface HitlCardCommentSource {
  author?: string;
  authorType?: string;
  body: string;
  allowedAuthors: readonly string[];
}

/**
 * Reject automation before either slash-command or natural-language parsing.
 * GitHub's default token reports `Bot`, while a PAT can make automation look
 * like a `User`; requiring an explicitly eligible human login before parsing
 * closes that path independently of the stable outbound-marker guard.
 */
export function shouldIgnoreHitlCardComment(input: HitlCardCommentSource): boolean {
  const authorType = input.authorType?.trim().toLowerCase();
  if (authorType !== "user") return true;

  const author = input.author?.trim().toLowerCase() ?? "";
  const allowedAuthors = new Set(input.allowedAuthors.map((login) => login.trim().toLowerCase()));
  if (!author || !allowedAuthors.has(author)) return true;

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
  author?: string;
  authorType?: string;
}

export interface HitlCardActorIdentity {
  login: string;
  type: string;
}

export interface HitlCardActionRate {
  actionCount: number;
  limited: boolean;
  shouldPostStandDown: boolean;
}

/**
 * Count completed card actions in a rolling window. A receipt counts only when
 * both its GitHub login/type identity and its exact leading marker match, so a
 * pasted or quoted marker from an ordinary comment cannot consume the budget.
 */
export function evaluateHitlCardActionRate(
  comments: readonly HitlCardActionComment[],
  now = new Date(),
  cardAuthors: readonly HitlCardActorIdentity[] = [],
): HitlCardActionRate {
  const cutoff = now.getTime() - HITL_CARD_ACTION_WINDOW_MS;
  const identities = new Set(cardAuthors.map(({ login, type }) =>
    `${login.trim().toLowerCase()}\0${type.trim().toLowerCase()}`));
  let actionCount = 0;
  let hasStandDown = false;

  for (const comment of comments) {
    const createdAt = Date.parse(comment.createdAt ?? "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff || createdAt > now.getTime()) continue;
    const identity = `${comment.author?.trim().toLowerCase() ?? ""}\0${comment.authorType?.trim().toLowerCase() ?? ""}`;
    if (!identities.has(identity)) continue;
    if (comment.body.startsWith(HITL_CARD_ACTION_MARKER)) actionCount += 1;
    if (comment.body.startsWith(HITL_CARD_STAND_DOWN_MARKER)) hasStandDown = true;
  }

  const limited = actionCount >= HITL_CARD_ACTION_LIMIT;
  return {
    actionCount,
    limited,
    shouldPostStandDown: limited && !hasStandDown,
  };
}
