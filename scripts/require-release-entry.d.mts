// Types for the release-entry gate, so its pure verdict can be unit-tested.
//
// The repo's other scripts are exercised by EXECUTING them, which needs no
// declarations — but a classifier is worth testing as a function, and a static
// import of an untyped `.mjs` is refused by `tsc`. Declaring the surface keeps
// the test at the seam that matters (the verdict) instead of pushing it out to
// a subprocess that can only observe an exit code.

/** Why a set of changed files does or does not need a release entry. */
export interface ReleaseEntryVerdict {
  readonly ok: boolean;
  readonly kind: "exempt" | "release-entry-present" | "release-entry-missing";
  readonly message: string;
}

/** Classify one pull request's changed-file set. */
export function releaseEntryVerdict(changedFiles: readonly string[]): ReleaseEntryVerdict;

/** The files a pull request changed, as git reports them between two commits. */
export function changedFilesBetween(root: string, base: string, head: string): string[];

/** The CLI entry point. Returns the process exit code rather than exiting. */
export function run(
  argv?: readonly string[],
  sinks?: { log?: (message: string) => void; error?: (message: string) => void },
): number;
