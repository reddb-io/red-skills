/**
 * landing-merge-title — the conventional-commit title a landing writes.
 *
 * The merge subject is the one line every later reader sees: `git log --oneline`
 * on the trunk, the release notes generator, the changelog. It is derived, not
 * asked for — a landing has the issue's labels and the branch's changed files
 * and nothing else — so the derivation is a small classification with an order
 * that matters: a docs-only diff is `docs` however the issue was labelled, an
 * explicit type label beats a guess from paths, and a runtime path touched by
 * an unlabelled issue is a `fix` rather than a `chore`.
 *
 * Carved out of `landing.ts` (#4138) so the landing module holds the landing
 * SEQUENCE and this holds the naming, which is the only reason those lines ever
 * changed together.
 */


/** A path whose change ships no runtime behaviour: docs, prose, templates. PURE. */
function isDocsOnlyPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return normalized !== "" && (
    normalized.startsWith("docs/") ||
    normalized.startsWith(".github/issue_template/") ||
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx") ||
    normalized.endsWith(".txt") ||
    normalized.endsWith(".adoc") ||
    normalized.endsWith(".rst")
  );
}

/** A path under a source root whose extension executes. PURE. */
function isRuntimePath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  if (normalized === "" || isDocsOnlyPath(normalized)) return false;
  if (normalized.startsWith("apps/") || normalized.startsWith("packages/") || normalized.startsWith("plugins/")) {
    return /\.(cjs|cts|js|jsx|mjs|mts|sh|ts|tsx)$/.test(normalized);
  }
  if (normalized.startsWith("src/")) {
    return /\.(cjs|cts|js|jsx|mjs|mts|sh|ts|tsx)$/.test(normalized);
  }
  if (normalized.startsWith("scripts/") && !normalized.startsWith("scripts/test-")) {
    return /\.(cjs|cts|js|jsx|mjs|mts|sh|ts|tsx)$/.test(normalized);
  }
  return false;
}

/** The `<type>: #<issue> <title>` subject the landing merges under. PURE. */
export function landingMergeTitle(input: {
  issue: number;
  title: string;
  labels?: readonly string[];
  changedFiles?: readonly string[];
}): string {
  const labels = new Set((input.labels ?? []).map((label) => label.trim().toLowerCase()));
  let prefix = "chore";
  const changedFiles = input.changedFiles ?? [];
  if (changedFiles.length > 0 && changedFiles.every(isDocsOnlyPath)) {
    prefix = "docs";
  } else if (labels.has("type:bug") || labels.has("bug") || labels.has("type:fix") || labels.has("fix")) {
    prefix = "fix";
  } else if (
    labels.has("type:feature") ||
    labels.has("feature") ||
    labels.has("type:enhancement") ||
    labels.has("enhancement")
  ) {
    prefix = "feat";
  } else if (changedFiles.some(isRuntimePath)) {
    prefix = "fix";
  }
  return `${prefix}: #${input.issue} ${input.title}`;
}
