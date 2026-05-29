import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { type MemoryConfig, readConfig, resolveStoreUri } from "./config.js";
import { exportGraph } from "./export.js";
import {
  type GitChange,
  parseNameStatusZ,
  postCheckoutRange,
  postCommitRange,
  type RevRange,
  selectIngestPaths,
} from "./git-diff-selection.js";
import { MemoryStore } from "./graph-store.js";
import { type IngestReport, refreshFiles } from "./ingest.js";

const execFileAsync = promisify(execFile);

/** Default on-disk export bundle, kept in sync with the `memory export` CLI. */
export const DEFAULT_EXPORT_DIR = ".red/memory/export";

/** The git lifecycle events the auto-update hooks fire on. */
export type VcsEvent = "post-commit" | "post-checkout";

export interface VcsRefreshOptions {
  event: VcsEvent;
  /** post-checkout arg 1 — the HEAD before the checkout. */
  prevHead?: string;
  /** post-checkout arg 2 — the HEAD after the checkout. */
  newHead?: string;
  /** post-checkout arg 3 — `"1"` for a branch checkout, `"0"` for a file one. */
  flag?: string;
  /** Re-export the graph bundle after refreshing. Default true. */
  export?: boolean;
}

export interface VcsRefreshResult {
  /** True when the hook deliberately did nothing (not initialized / nothing to do). */
  noop: boolean;
  reason?: string;
  event: VcsEvent;
  range?: RevRange;
  /** The incremental refresh report, when files were refreshed. */
  refresh?: IngestReport;
  /** Summary of the re-export, when one ran. */
  exported?: { nodes: number; edges: number; jsonPath: string };
}

/** Seams the orchestrator reaches the outside world through; overridable in tests. */
export interface VcsRefreshDeps {
  readConfig: typeof readConfig;
  runGit: (rootDir: string, args: string[]) => Promise<string>;
  openStore: (uri: string) => Promise<MemoryStore>;
  refreshFiles: typeof refreshFiles;
  exportGraph: typeof exportGraph;
}

async function defaultRunGit(rootDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export function defaultVcsRefreshDeps(): VcsRefreshDeps {
  return {
    readConfig,
    runGit: defaultRunGit,
    openStore: (uri) => MemoryStore.open({ uri }),
    refreshFiles,
    exportGraph,
  };
}

/** Resolve the diff range for the event, shelling out to git only as needed. */
async function resolveRange(
  rootDir: string,
  opts: VcsRefreshOptions,
  runGit: VcsRefreshDeps["runGit"],
): Promise<RevRange | null> {
  if (opts.event === "post-checkout") {
    return postCheckoutRange(opts.prevHead ?? "", opts.newHead ?? "", opts.flag ?? "");
  }
  // post-commit: the new commit against its first parent (or the empty tree on
  // a root commit, where `HEAD~1` does not resolve).
  const head = (await runGit(rootDir, ["rev-parse", "HEAD"])).trim();
  if (!head) return null;
  let parent: string | undefined;
  try {
    parent = (await runGit(rootDir, ["rev-parse", "--verify", "--quiet", "HEAD~1"])).trim();
    if (!parent) parent = undefined;
  } catch {
    parent = undefined; // root commit has no parent
  }
  return postCommitRange(head, parent);
}

/**
 * Run an incremental re-ingest (and, by default, a re-export) driven by a git
 * lifecycle event. The closed-loop git half of issue #236:
 *
 * - No-op — never throws to the caller's intent — when memory is not
 *   initialized here or the project is not in graph mode (AC5). Git hooks must
 *   not break `git commit` / `git checkout`, so the CLI wrapper additionally
 *   swallows unexpected errors; this function keeps the *gating* explicit.
 * - Resolves the changed-file set from `git diff --name-status` over the
 *   event's rev range, then refreshes only those files (AC3 — incremental).
 * - Re-exports `graph.json` so the on-disk bundle tracks the working tree.
 */
export async function refreshFromGit(
  rootDir: string,
  opts: VcsRefreshOptions,
  deps: VcsRefreshDeps = defaultVcsRefreshDeps(),
): Promise<VcsRefreshResult> {
  const config = await deps.readConfig(rootDir);
  if (!config) return { noop: true, reason: "memory not initialized", event: opts.event };
  if (config.mode !== "graph") {
    return { noop: true, reason: `needs graph mode (project is "${config.mode}")`, event: opts.event };
  }

  const range = await resolveRange(rootDir, opts, deps.runGit);
  if (!range) {
    return { noop: true, reason: "no rev range to diff (e.g. file checkout)", event: opts.event };
  }

  let changes: GitChange[];
  try {
    const raw = await deps.runGit(rootDir, [
      "diff",
      "--name-status",
      "-z",
      range.from,
      range.to,
    ]);
    changes = parseNameStatusZ(raw);
  } catch {
    return { noop: true, reason: "git diff failed", event: opts.event, range };
  }

  const selection = selectIngestPaths(changes);
  if (selection.paths.length === 0) {
    return { noop: true, reason: "no changed files", event: opts.event, range };
  }

  const storeUri = resolveStoreUri(rootDir, config);
  const store = await deps.openStore(storeUri);
  let result: VcsRefreshResult;
  try {
    const refresh = await deps.refreshFiles(store, selection.paths, { rootDir });
    result = { noop: false, event: opts.event, range, refresh };
    if (opts.export !== false) {
      const out = await deps.exportGraph(store, resolve(rootDir, DEFAULT_EXPORT_DIR));
      result.exported = { nodes: out.nodes, edges: out.edges, jsonPath: out.jsonPath };
    }
  } finally {
    await store.close();
  }
  return result;
}
