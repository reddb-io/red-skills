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

export type { MonitorInputs, DeadWorkerSweepDeps } from "./wire/monitor.js";
export { readFleetState, reclaimDeadWorkers, collectMonitorInputs } from "./wire/monitor.js";

export type { StatuslineRefreshSpawnOptions } from "./wire/statusline-cache.js";
export {
  STATUSLINE_CACHE_TTL_S,
  STATUSLINE_REFRESH_LOCK_TTL_S,
  STATUSLINE_GH_COLD_TIMEOUT_MS,
  resolveStatuslineCacheTtl,
  withTimeout,
  statuslineCountCachePath,
  parseGitHubRepoSlugFromRemoteUrl,
  inferGitHubRepoSlug,
  applyStatuslineCountCacheLabelDelta,
  editLabelsWithStatuslineCache,
  refreshStatuslineCountCache,
  startDetachedStatuslineCountRefresh,
} from "./wire/statusline-cache.js";

export {
  collectStatuslineAfk,
  collectStatuslineFleet,
  collectStatuslineValidationGate,
  collectStatuslineWorkers,
  collectStatuslineRepo,
  refreshStatuslineRepoCache,
} from "./wire/statusline.js";

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
