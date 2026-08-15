import type { HookDispatchResult } from "../hook-dispatcher.js";
import type { HookName } from "../hook-config.js";
import { ensureRemoteWorkVisible, terminalFailure, type StageCommon } from "./terminal.js";
import type { ProcessIssueResult } from "./types.js";

export interface HookAbortDetail {
  name: HookName;
  command?: string;
  rc: number;
  stdoutProtocolViolation: boolean;
}

/** Preserve the command-level cause that Landing's boolean hook port omits. */
export function hookAbortDetail(name: HookName, result: HookDispatchResult): HookAbortDetail | undefined {
  if (!result.aborted) return undefined;
  const failed = result.executions.at(-1);
  return {
    name,
    command: failed?.command,
    rc: result.rc,
    // A dispatcher parse failure reports EX_DATAERR while the hook process
    // itself succeeded. A real hook that exits 65 retains execution rc=65.
    stdoutProtocolViolation: result.rc === 65 && failed?.rc === 0,
  };
}

/** Route a pre_merge hook refusal as bounded policy, never as branch conflict. */
export async function hookAbortedLanding(
  common: StageCommon,
  lastAbort: HookAbortDetail | undefined,
): Promise<ProcessIssueResult> {
  const hook = lastAbort?.name === "pre_merge" ? lastAbort : undefined;
  const command = hook?.command ? ` \`${hook.command}\`` : "";
  const summary = hook?.stdoutProtocolViolation
    ? `pre_merge hook${command} violated the hook stdout protocol: invalid structured stdout (expected empty stdout or a JSON object).`
    : `pre_merge hook${command} aborted the landing${hook ? ` (rc=${hook.rc})` : ""}.`;
  const visiblePr = await ensureRemoteWorkVisible(common);
  const notes = visiblePr === undefined
    ? summary
    : `${summary} The completed worker branch remains visible in PR #${visiblePr}; do not re-run the implementation.`;
  common.deps.recordWorkerEvent?.("worker.blocked", {
    outcome: "hook-aborted",
    reason: hook?.stdoutProtocolViolation ? "hook-stdout-protocol" : "pre_merge-abort",
    hook: "pre_merge",
  });
  return terminalFailure(
    common,
    "hook-aborted",
    hook?.stdoutProtocolViolation
      ? "pre_merge hook: invalid structured stdout"
      : "pre_merge hook: landing aborted",
    { notes },
    { notes },
  );
}
