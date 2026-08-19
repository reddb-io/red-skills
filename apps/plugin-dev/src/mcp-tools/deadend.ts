import type { CastleMcpTool } from "./tool.js";

export interface DeadendDependencies {
  /**
   * Return the cron-refreshed, cache-backed deadend audit: every stuck AFK
   * pattern with its recommended cure. Read-only — the host implementation
   * mutates nothing and repeated calls within the refresh window cost zero
   * GitHub quota.
   */
  deadendAudit(): Promise<unknown>;
}

export function createDeadendTools(deps: DeadendDependencies): CastleMcpTool[] {
  return [
    {
      name: "deadend_audit",
      title: "Audit AFK deadends",
      description:
        "Return the read-only deadend audit: dangling claims, red PRs with dead owners, superseded PRs, executable Tickets carrying an active Current blocker, dependency blocks whose req targets all closed, human-queue age outliers, and stale worktrees — each class paired with its recommended cure. Cache-backed: repeated calls within the refresh window cost zero GitHub quota.",
      inputSchema: {},
      invoke: () => deps.deadendAudit(),
    },
  ];
}
