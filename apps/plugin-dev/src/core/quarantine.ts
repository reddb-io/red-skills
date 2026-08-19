// quarantine.ts — config-declared flaky-test quarantine lane (issue #1035).
//
// A QuarantineEntry carries the test file pattern, a mandatory tracker-issue
// URL, and the date it was added. The gate reads the list, validates it (a
// missing issue ref causes a loud gate failure — a misconfigured quarantine
// must never silently skip tests), emits visible "skipped/quarantined" sidecar
// records so exclusions are envelope-visible, and passes --exclude args to
// vitest so the tests actually do not run. An optional staleness check (used
// by /red-doctor) warns when the referenced issue is already closed.

import type { ConfigValues } from "./config.js";

/** One entry in the quarantine list. */
export interface QuarantineEntry {
  /** Repo-relative file path for vitest --exclude. E.g. "apps/plugin-dev/tests/supervisor.test.ts" */
  pattern: string;
  /** Mandatory GitHub issue URL. Gate fails loudly when absent. */
  issue: string;
  /** ISO-8601 date the entry was added ("YYYY-MM-DD"). */
  since: string;
  /** Optional human note (the "why"). */
  reason?: string;
}

/** Thrown by {@link validateQuarantine} when an entry is missing its issue ref. */
export class QuarantineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineConfigError";
  }
}

/**
 * Read the operator-declared quarantine list from the flat config map.
 *
 * YAML shape (namespaced form; `loadConfig` folds `plugins.dev.afk.*` → `afk.*`):
 *
 *   plugins:
 *     dev:
 *       afk:
 *         test:
 *           quarantine:
 *             e0:
 *               pattern: apps/plugin-dev/tests/supervisor.test.ts
 *               issue: "https://github.com/reddb-io/red-skills/issues/1063"
 *               since: "2026-07-02"
 *               reason: "OOM under fleet=2 load (exit 137 / SIGKILL)"
 *
 * Reads `afk.test.quarantine.e{N}.pattern` until the first gap. Returns `[]`
 * when no entries are configured.
 */
export function readQuarantine(values: ConfigValues): QuarantineEntry[] {
  const entries: QuarantineEntry[] = [];
  for (let i = 0; ; i++) {
    const prefix = `afk.test.quarantine.e${i}`;
    const pattern = values[`${prefix}.pattern`];
    if (pattern === undefined) break;
    const issue = values[`${prefix}.issue`] ?? "";
    const since = values[`${prefix}.since`] ?? "";
    const reason = values[`${prefix}.reason`];
    entries.push({ pattern, issue, since, reason: reason || undefined });
  }
  return entries;
}

/**
 * Validate the quarantine list — every entry must carry a tracker issue
 * reference. A misconfigured quarantine must not silently skip tests.
 * Throws {@link QuarantineConfigError} on the first violation.
 */
export function validateQuarantine(entries: readonly QuarantineEntry[]): void {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.issue.trim()) {
      throw new QuarantineConfigError(
        `quarantine entry ${i} (pattern: "${entry.pattern}") has no issue reference — ` +
          `every quarantine entry must link to a tracker issue`,
      );
    }
  }
}

/**
 * Return vitest `--exclude` CLI arg pairs for quarantine entries that apply to
 * a given scope. The pattern is stripped of its scope prefix to produce a
 * scope-relative path for vitest's `--exclude` flag.
 *
 * Root scope (`"."`) matches all patterns (the root runs the whole workspace).
 * Any other scope matches only patterns whose repo-relative path begins with
 * `<scope>/`; the prefix is stripped before returning.
 */
export function quarantineExcludeArgs(entries: readonly QuarantineEntry[], scope: string): string[] {
  const args: string[] = [];
  const prefix = scope === "." ? "" : `${scope}/`;
  for (const entry of entries) {
    if (scope === "." || entry.pattern.startsWith(prefix)) {
      const rel = scope === "." ? entry.pattern : entry.pattern.slice(prefix.length);
      args.push("--exclude", rel);
    }
  }
  return args;
}

/** Return quarantine entries whose pattern falls within a given scope. */
export function scopeQuarantineEntries(entries: readonly QuarantineEntry[], scope: string): QuarantineEntry[] {
  const prefix = scope === "." ? "" : `${scope}/`;
  return entries.filter((e) => scope === "." || e.pattern.startsWith(prefix));
}

/** Injectable: report whether a GitHub issue URL is open, closed, or unknown. */
export type IssueStateChecker = (issueUrl: string) => Promise<"open" | "closed" | "unknown">;

export interface QuarantineStaleEntry {
  entry: QuarantineEntry;
  warning: string;
}

export interface QuarantineStalenessResult {
  staleEntries: QuarantineStaleEntry[];
}

/**
 * Warn when a quarantine entry's referenced issue is closed. Quarantine is
 * managed debt with an exit path — a closed issue means the underlying problem
 * was fixed and the entry should be removed. Returns an empty list when all
 * issues are open or the checker returns "unknown".
 */
export async function checkQuarantineStaleness(
  entries: readonly QuarantineEntry[],
  checkIssue: IssueStateChecker,
): Promise<QuarantineStalenessResult> {
  const staleEntries: QuarantineStaleEntry[] = [];
  for (const entry of entries) {
    if (!entry.issue.trim()) continue;
    const state = await checkIssue(entry.issue);
    if (state === "closed") {
      staleEntries.push({
        entry,
        warning:
          `quarantine for "${entry.pattern}" references closed issue ${entry.issue} — ` +
          `remove or update this quarantine entry`,
      });
    }
  }
  return { staleEntries };
}
