// file-size-guard — a shrink-only ratchet on source file length.
//
// A split that nothing enforces is a split that comes back. `mcp-adapter.ts` and
// `daemon.ts` were each decomposed once and each grew back into one file holding
// many domains, because nothing in the gate could tell a module apart from an
// accumulation.
//
// The destination is NOT "every file under the threshold" — 58 were already over
// it when this landed, and demanding 58 refactors in one change is how a rule
// gets turned off. The destination is that the NEXT one cannot happen: a file
// absent from the baseline may not exceed the threshold, and a file in it may
// only shrink. Each entry is a debt with a number on it.
//
// A file that drops below the threshold LEAVES the baseline. Keeping it would
// re-authorise the growth the shrink just paid for.

/** Longest a source file may be without a declared, shrinking exception. */
export const FILE_SIZE_THRESHOLD = 800;

export interface FileSizeBaselineEntry {
  readonly path: string;
  readonly lines: number;
}

/**
 * Files over the threshold when the ratchet landed. Shrink-only: lower a number
 * as a file is decomposed, remove the entry once it passes under, and never add
 * one — a new entry is the accumulation this exists to refuse.
 */
export const FILE_SIZE_BASELINE: readonly FileSizeBaselineEntry[] = [
  { path: "apps/brain/src/store.ts", lines: 819 },
  { path: "apps/dev/src/commands/red-doctor.ts", lines: 1080 },
  { path: "apps/dev/src/commands/run/command.ts", lines: 819 },
  { path: "apps/dev/src/commands/run/process-deps.ts", lines: 1005 },
  { path: "apps/dev/src/core/adr-triage.ts", lines: 821 },
  { path: "apps/dev/src/core/boot.ts", lines: 1606 },
  { path: "apps/dev/src/core/config.ts", lines: 1401 },
  { path: "apps/dev/src/core/execution/runtime.ts", lines: 1266 },
  { path: "apps/dev/src/core/feedback.ts", lines: 1206 },
  { path: "apps/dev/src/core/landing.ts", lines: 1183 },
  { path: "apps/dev/src/core/merge.ts", lines: 2672 },
  { path: "apps/dev/src/core/process-issue/lifecycle.ts", lines: 2258 },
  { path: "apps/dev/src/core/process-issue/terminal.ts", lines: 1367 },
  { path: "apps/dev/src/core/reconcile.ts", lines: 1103 },
  { path: "apps/dev/src/runtime/doctor-classifiers.ts", lines: 900 },
  { path: "apps/dev/src/runtime/feedback-worktree.ts", lines: 1045 },
  { path: "apps/dev/src/runtime/git.ts", lines: 1023 },
  { path: "apps/dev/tests/process-issue.test-helpers.ts", lines: 971 },
  { path: "apps/memory/src/bench-eval/runner.ts", lines: 1092 },
  { path: "apps/memory/src/cli/core.ts", lines: 1059 },
  { path: "apps/memory/src/cli/docs.ts", lines: 872 },
  { path: "apps/memory/src/cli/improve-build.ts", lines: 856 },
  { path: "apps/memory/src/cli/recall.ts", lines: 893 },
  { path: "apps/memory/src/cli/reports.ts", lines: 1060 },
  { path: "apps/memory/src/cli/status.ts", lines: 925 },
  { path: "apps/memory/src/engine/core.ts", lines: 1050 },
  { path: "apps/memory/src/export/core.ts", lines: 958 },
  { path: "apps/memory/src/extract-code.ts", lines: 938 },
  { path: "apps/memory/src/graph-store/store.ts", lines: 1090 },
  { path: "apps/memory/src/http-server.ts", lines: 1104 },
  { path: "apps/memory/src/mcp-server/runtime.ts", lines: 853 },
  { path: "apps/memory/src/memory-events.ts", lines: 836 },
  { path: "apps/memory/src/operations/definitions-core.ts", lines: 1190 },
  { path: "apps/memory/src/operations/definitions-docs.ts", lines: 1235 },
  { path: "apps/memory/src/operations/definitions-system.ts", lines: 1080 },
  { path: "apps/memory/src/operations/facets.ts", lines: 818 },
  { path: "apps/memory/src/operations/schemas.ts", lines: 1042 },
  { path: "apps/memory/src/workbench/render.ts", lines: 812 },
  { path: "apps/memory/src/workbench/scripts.ts", lines: 1097 },
  // Its option, registration and handle types moved to ./daemon/types.ts and its
  // intervals to ./daemon/tunables.ts. What remains is ONE function of ~2280
  // lines: forty inner functions closing over sixty locals. That is a FUNCTION
  // length problem, and a file-size rule cannot fix it — slicing the closure
  // into modules that each take a sixty-field context object would satisfy this
  // number and leave the code worse. The entry states the debt with a ceiling;
  // paying it means decomposing the function, not moving its lines.
  { path: "apps/redskilled/src/daemon/lifecycle.ts", lines: 2489 },
  { path: "apps/redskilled/src/cli.ts", lines: 1036 },
  { path: "apps/redskilled/src/client.ts", lines: 1003 },
  { path: "apps/redskilled/src/statusline-payload.ts", lines: 864 },
  { path: "apps/rsp/src/resident-server.ts", lines: 931 },
  { path: "apps/rsp/src/two-axis-benchmark.ts", lines: 878 },
  { path: "apps/rsp/tests/cli.helpers.ts", lines: 828 },
  { path: "packages/github/balance.ts", lines: 907 },
  { path: "packages/red-castle/src/AgentProvider.ts", lines: 1184 },
  { path: "packages/red-castle/src/InitService.ts", lines: 1086 },
  { path: "packages/red-castle/src/Orchestrator.ts", lines: 827 },
  { path: "packages/red-castle/src/cli.ts", lines: 811 },
  { path: "packages/red-castle/src/createSandbox.ts", lines: 1151 },
  { path: "packages/red-castle/src/createWorktree.ts", lines: 823 },
  { path: "packages/red-castle/src/engine/monitor.ts", lines: 805 },
  { path: "packages/red-castle/src/engine/tracker/claim.ts", lines: 1026 },
  { path: "packages/red-castle/src/run.ts", lines: 1023 },
];

export type FileSizeFindingKind = "over-threshold" | "over-baseline" | "stale-baseline";

export interface FileSizeFinding {
  readonly path: string;
  readonly lines: number;
  readonly kind: FileSizeFindingKind;
  readonly reason: string;
}

/** Judge measured file lengths against the threshold and the baseline. PURE. */
export function auditFileSizes(
  measured: ReadonlyMap<string, number>,
  baseline: readonly FileSizeBaselineEntry[] = FILE_SIZE_BASELINE,
): FileSizeFinding[] {
  const allowed = new Map(baseline.map((entry) => [entry.path, entry.lines]));
  const findings: FileSizeFinding[] = [];

  for (const [path, lines] of [...measured].sort()) {
    const budget = allowed.get(path);
    if (budget === undefined) {
      if (lines > FILE_SIZE_THRESHOLD) {
        findings.push({
          path,
          lines,
          kind: "over-threshold",
          reason: `${path} is ${lines} lines, over the ${FILE_SIZE_THRESHOLD}-line threshold. Split it by domain — the baseline records debt that predates this ratchet, never a new file.`,
        });
      }
      continue;
    }
    if (lines > budget) {
      findings.push({
        path,
        lines,
        kind: "over-baseline",
        reason: `${path} grew from ${budget} to ${lines} lines. The baseline is shrink-only: lower the number as the file is decomposed, never raise it.`,
      });
    }
  }

  for (const entry of baseline) {
    const lines = measured.get(entry.path);
    if (lines !== undefined && lines <= FILE_SIZE_THRESHOLD) {
      findings.push({
        path: entry.path,
        lines,
        kind: "stale-baseline",
        reason: `${entry.path} is now ${lines} lines and under the threshold — drop its baseline entry. Leaving it re-authorises the growth the shrink just paid for.`,
      });
    }
  }

  return findings;
}
