import type { ProcessIssueDeps } from "../../../core/process-issue.js";
import type { ConfigValues } from "../../../core/config.js";
import type { Runner } from "../../../types/runner.js";
import { resolveHooks, type ResolveHooksOptions } from "../../../core/hook-config.js";
import { makeHookExec, makeHookResolveOptions, hookEnv } from "../../../runtime/hooks.js";

export interface HooksPortContext {
  config: ConfigValues;
  root: string;
  repo: string;
  runner: Runner;
  slot?: number;
  /** Injected only by tests that need to pin the resolve options. */
  resolveOptions?: ResolveHooksOptions;
}

/**
 * Lifecycle-hook port: config + the repo it is anchored to. `resolveHooks` runs
 * once here to surface a malformed-hook-name error early; process-issue
 * re-resolves per run from the same config + options.
 */
export function buildHooks({
  config,
  root,
  repo,
  runner,
  slot,
  resolveOptions = makeHookResolveOptions(root),
}: HooksPortContext): NonNullable<ProcessIssueDeps["hooks"]> {
  resolveHooks(config, resolveOptions);
  return {
    config,
    resolveOptions,
    exec: makeHookExec(root),
    env: hookEnv(repo, root, slot, runner),
  };
}
