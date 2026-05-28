/**
 * Declarative list of the repo paths the PostToolUse hook watches for the
 * closed loop (ADR 0027 Amendment). When an `Edit` / `Write` / `apply_patch`
 * touches none of these, {@link isWatchedPath} returns false for every path and
 * the hook short-circuits to a noop before opening the store — editing ordinary
 * source no longer drives an ingest, only the curated memory surfaces do.
 *
 * This is the ONE place the watched set is declared. Adding a new memory surface
 * (e.g. `.red/contracts/**`) is a one-line change to {@link WATCHED_GLOBS}; no
 * handler, matcher, or `.hooks.json` edit is required. The list is documented in
 * `.red/agents/memory.md`.
 *
 * Rationale for a `const` (over a config block or a `MemoryConfig` extension):
 * the watched surfaces are a property of the closed-loop *design*, not a
 * per-project knob — every RedSkills clone has the same `.red/` layout — so a
 * versioned constant keeps the contract in the codebase and bisectable, with no
 * config-migration burden when a surface is added.
 */
export const WATCHED_GLOBS = [
  ".red/adr/**/*.md",
  ".red/wiki/pages/**/*.md",
  ".red/CONTEXT.md",
  ".red/CONTEXT-MAP.md",
  ".red/contexts/**/*.md",
] as const;

/**
 * Compile one glob into an anchored RegExp that matches the glob as a path
 * suffix (so absolute changed-file paths match a repo-relative watched glob).
 * Supports the only constructs the watched list uses: `**` (any number of path
 * segments, including none, when followed by `/`), `*` (any run of non-`/`
 * characters), and literal segments. Regex metacharacters are escaped.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          // `**/` → zero or more whole path segments.
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`(?:^|/)${re}$`);
}

/**
 * Compile a glob list into a path matcher. Both predicates normalise Windows
 * separators and match each glob as a path suffix, so an absolute changed-file
 * path matches a repo-relative watched glob. Reused by the PostToolUse hook
 * (over {@link WATCHED_GLOBS}) and by the CI drift guard (#224), which watches
 * a deliberately narrower set — the gitignored, auto-generated `.red/wiki/`
 * surface is excluded from PR-level enforcement.
 */
export function compileGlobMatcher(globs: readonly string[]): {
  isMatch: (path: string) => boolean;
  filter: (paths: readonly string[]) => string[];
} {
  const matchers = globs.map(globToRegExp);
  const isMatch = (path: string): boolean => {
    const normalized = path.replace(/\\/g, "/");
    return matchers.some((re) => re.test(normalized));
  };
  return { isMatch, filter: (paths) => paths.filter(isMatch) };
}

const WATCHED_MATCHER = compileGlobMatcher(WATCHED_GLOBS);

/** True when `path` matches any {@link WATCHED_GLOBS} entry as a path suffix. */
export function isWatchedPath(path: string): boolean {
  return WATCHED_MATCHER.isMatch(path);
}

/** Keep only the paths the closed loop watches. Order is preserved. */
export function filterWatchedPaths(paths: readonly string[]): string[] {
  return WATCHED_MATCHER.filter(paths);
}
