// runtime/wire.ts — barrel for runtime wiring modules.
//
// Keep this filename stable: NodeNext consumers import it through the existing
// explicit wire.ts.js specifier.

export type { RepoContext, AfkPaths } from "./wire/paths.js";
export { resolveRepoSlug, resolveRepoContext, afkPaths } from "./wire/paths.js";

export type { RunSettings, AttemptProbeArming } from "./wire/settings.js";
export {
  resolveRunSettings,
  agentLivenessVerdictSync,
  resolveAttemptProbeArming,
  resolveAttemptHead,
  makeRunAgent,
} from "./wire/settings.js";

export type { MonitorInputs } from "./wire/monitor.js";
export { readFleetState, collectMonitorInputs } from "./wire/monitor.js";

export { parseGitHubRepoSlugFromRemoteUrl, inferGitHubRepoSlug } from "./wire/github-slug.js";

export {
  collectStatuslineAfk,
  collectStatuslineFleet,
  collectStatuslineValidationGate,
  collectStatuslineWorkers,
} from "./wire/statusline.js";

export type { StatuslineLocalGit, StatuslineLocalGitDeps } from "./wire/statusline-git.js";
export {
  STATUSLINE_GIT_MICRO_TTL_MS,
  STATUSLINE_GIT_DEADLINE_MS,
  collectStatuslineLocalGit,
  decodeCacheDocument,
  resolveRepoBasename,
  withTimeout,
} from "./wire/statusline-git.js";

export { collectStatuslineDocs, collectDocsSweepInput, landDocsSweep } from "./wire/docs.js";

export type { ReapInputs } from "./wire/reap.js";
export { collectReapInputs } from "./wire/reap.js";

export type { CollectPrecheckFactsOptions, CollectBootPrecheckFactsOptions } from "./wire/boot.js";
export {
  collectBootOptions,
  collectPrecheckFacts,
  collectBootPrecheckFacts,
  buildBootDeps,
  buildMinimalBootDeps,
} from "./wire/boot.js";
