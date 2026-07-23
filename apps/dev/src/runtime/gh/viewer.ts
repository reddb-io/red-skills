import { runGh, type GhContext } from "./common.js";

/**
 * Resolve the authenticated gh user's login — the concretization step for a
 * `--user @me` selector facet. Throws when gh cannot answer, because silently
 * keeping the literal `@me` would make the user facet match nothing and the
 * scoped queue would drain empty with no visible cause.
 */
export async function resolveViewerLogin(ctx: GhContext): Promise<string> {
  const r = await runGh(ctx, ["api", "user", "-q", ".login"]);
  const login = r.stdout.trim();
  if (r.code !== 0 || !login) {
    throw new Error("could not resolve @me to a GitHub login (`gh api user` failed)");
  }
  return login;
}

/**
 * Replace a `@me` user facet with a concrete login, leaving every other
 * selector untouched. `resolveLogin` is only invoked when needed, so callers
 * with no `@me` facet pay no gh round-trip.
 */
export async function resolveSelectorUser<T extends { user?: string }>(
  selector: T,
  resolveLogin: () => Promise<string>,
): Promise<T> {
  if (selector.user !== "@me") return selector;
  return { ...selector, user: await resolveLogin() };
}
