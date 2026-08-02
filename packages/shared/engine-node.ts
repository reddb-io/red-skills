import { delimiter, dirname } from "node:path";

/**
 * The node the engine runs on, carried down instead of searched for (#3064).
 *
 * A Worker is born into a sanitized PATH — the init system's under a transient
 * unit, an allowlisted subset otherwise — and that PATH is the SYSTEM's, never
 * the operator's shell. On a version-manager host (mise, nvm, asdf, volta) node
 * lives only under the manager's install root, so every system tool resolves
 * and node alone goes missing: the prereq probe reds out while the very process
 * printing the failure is itself a node process.
 *
 * `process.execPath` is the absolute answer that process already holds. These
 * helpers hand it down rather than probe for it, and they name the directories
 * a lookup searched so a failure is diagnosable in one read.
 */

/** The PATH entries a lookup would search, in order, empties dropped. PURE. */
export function splitSearchPath(path: string | undefined, sep: string = delimiter): readonly string[] {
  return (path ?? "")
    .split(sep)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The directory holding the node binary this process runs on, or null when the
 * interpreter path is unusable (an empty or relative `execPath`, which no PATH
 * entry could be built from).
 */
export function engineNodeDir(execPath: string = process.execPath): string | null {
  const trimmed = (execPath ?? "").trim();
  if (trimmed === "") return null;
  const dir = dirname(trimmed);
  return dir === "" || dir === "." ? null : dir;
}

/**
 * The PATH a child must be given: the engine's own node directory FIRST, then
 * everything the caller already had. The directory is moved rather than
 * duplicated, so a PATH that already carried it keeps exactly one entry.
 */
export function pathWithEngineNode(
  path: string | undefined,
  execPath: string = process.execPath,
  sep: string = delimiter,
): string {
  const entries = splitSearchPath(path, sep);
  const dir = engineNodeDir(execPath);
  if (dir == null) return entries.join(sep);
  return [dir, ...entries.filter((entry) => entry !== dir)].join(sep);
}

/**
 * Prepend the engine's own node directory to an environment's PATH, in place.
 *
 * Called once at a front door, it makes every descendant of that process —
 * the agent CLI, git hooks, `sh -c command -v node`, npx — resolve the SAME
 * node the engine is running on. Returns the resulting PATH.
 */
export function adoptEngineNodeOnPath(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  sep: string = delimiter,
): string {
  const next = pathWithEngineNode(env.PATH, execPath, sep);
  env.PATH = next;
  return next;
}

/** Name the directories a PATH lookup searched, for a failure message. PURE. */
export function describeSearchedPath(path: string | undefined, sep: string = delimiter): string {
  const dirs = splitSearchPath(path, sep);
  return dirs.length === 0 ? "PATH was empty" : `searched PATH: ${dirs.join(", ")}`;
}
