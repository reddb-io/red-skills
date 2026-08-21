// statusline-git — the LOCAL git facts of the Statusline Bedrock (ADR 0141 §1).
//
// **The implementation moved DOWN to `@reddb-io/shared`** so the `redskilled`
// daemon can draw the bedrock it now owns: ADR 0147 deleted the dev bundle that
// used to hold this reach, and the dependency-direction guard (#4135) forbids
// the daemon (rank 4) importing a runtime (rank 5). This module is the seam its
// existing callers already import; the facts, the micro-TTL and the deadline are
// one spelling, in `packages/shared/statusline-local-git.ts`.
//
// `withTimeout` and `decodeCacheDocument` keep their local spellings because
// `./statusline-lifecycle.ts` reaches for them by those names.

export type {
  StatuslineLocalGit,
  StatuslineLocalGitDeps,
} from "@reddb-io/shared/statusline-local-git.js";
export {
  STATUSLINE_GIT_DEADLINE_MS,
  STATUSLINE_GIT_MICRO_TTL_MS,
  collectStatuslineLocalGit,
  decodeStatuslineCacheDocument as decodeCacheDocument,
  resolveStatuslineRepoBasename as resolveRepoBasename,
  withStatuslineTimeout as withTimeout,
} from "@reddb-io/shared/statusline-local-git.js";
