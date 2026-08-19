import { isGithubQuotaText } from "@reddb-io/shared/github-quota.js";
import { isRunnerExhausted as isAiRunnerExhausted } from "@reddb-io/worker/engine";

export { claudeSpawnArgs, codexSpawnArgs, specialUserRequestBlock } from "@reddb-io/worker/engine";
export type { SpawnArgsInput, SpawnInvocation } from "@reddb-io/worker/engine";

/**
 * True when `text` carries a quota-exhaustion signal — the seam that maps a
 * failure to the `exhausted` outcome and from there to the bounded `quota`
 * recovery reason.
 *
 * Two families, one verdict. The AI-runner signals (usage limit, weekly cap,
 * `rate_limit_error`, 429, insufficient credit) are matched by red-castle's
 * detector, unchanged. GitHub's own quota — whose primary limit is a **403**
 * and resembles none of those — is matched by the shared GitHub quota
 * classifier (#2830). Before this, a GitHub rate limit fell through to a
 * generic failure instead of the bounded quota recovery path that already
 * existed for the AI-runner case.
 */
export function isRunnerExhausted(text: string): boolean {
  return isAiRunnerExhausted(text) || isGithubQuotaText(text);
}
