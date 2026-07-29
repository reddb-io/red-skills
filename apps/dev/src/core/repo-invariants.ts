// repo-invariants — repo-wide invariant suites that every gate run must include,
// no matter how narrow the cone (issue #2762).
//
// A cone-scoped gate runs the test/typecheck/lint/build of the changed packages
// and their dependents. That is correct for package-local behavior and WRONG for
// a repo-wide invariant: the TOON JSON file-I/O ratchet lives in `apps/dev` but
// constrains every file under `apps/` and `packages/`. A worker that edits only
// `apps/rsp` validates green, reports DONE, and the ratchet first fires in root
// CI — after the correction budget is spent. The invariant was enforced outside
// the only loop that could still satisfy it.
//
// The fix is a small, declared list: suites that run in EVERY gate run whose cone
// does not already cover them. Adding an invariant is a one-entry change here
// plus the package script it names.

/** One repo-wide invariant suite: a package script that constrains the whole repo. */
export interface RepoInvariantSuite {
  /** Canonical check name, surfaced in the sidecar record (`invariants:<slug>`). */
  name: string;
  /** Repo-relative dir of the package that owns the suite (never `"."`). */
  scope: string;
  /** The package script that runs ONLY the invariant suites (not the full suite). */
  script: string;
  /** One line on what the suite enforces — read by a human triaging a park. */
  why: string;
}

/**
 * The declared repo-wide invariant suites. Keep this list SHORT and CHEAP: every
 * entry runs on every cone-scoped gate run, so a slow suite taxes every landing.
 * A suite belongs here only when it enforces a constraint that spans packages.
 */
export const REPO_INVARIANT_SUITES: readonly RepoInvariantSuite[] = [
  {
    name: "invariants:toon-json-io",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the TOON JSON file-I/O ratchet constrains every file under apps/ and packages/, but its suite lives in apps/dev",
  },
];

/**
 * True when `scopes` already runs `suite` as part of the ordinary scoped loop —
 * either the whole-workspace scope (`"."`, which runs the workspace-wide turbo
 * commands) or the suite's own package is in the cone (its `test` script covers
 * the invariant suite too). PURE.
 */
export function scopesCoverInvariantSuite(
  scopes: readonly string[],
  suite: RepoInvariantSuite,
): boolean {
  return scopes.includes(".") || scopes.includes(suite.scope);
}

/**
 * The invariant suites a cone-scoped run must add on top of its scoped checks —
 * every declared suite the cone does not already cover. PURE.
 *
 * An empty `scopes` (a repo with no package.json anywhere) yields no suites: a
 * no-package repo has no script to run.
 */
export function pendingInvariantSuites(
  scopes: readonly string[],
  suites: readonly RepoInvariantSuite[] = REPO_INVARIANT_SUITES,
): RepoInvariantSuite[] {
  if (scopes.length === 0) return [];
  return suites.filter((suite) => !scopesCoverInvariantSuite(scopes, suite));
}
