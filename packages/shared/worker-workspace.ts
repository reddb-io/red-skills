import { join } from "node:path";
import { flatConfigValue } from "./plugin-gate.js";
import { workersDir as repoWorkersDir } from "./red-paths.js";
import { redskilledHomeDir } from "./redskilled-home.js";

/**
 * worker-workspace.ts — where a Worker's worktree, log and state live (Spec #2772).
 *
 * The location is a DECLARED CHOICE FROM A CLOSED SET, not a free path. Three
 * presets plus a free-form parent directory:
 *
 *   - `local` (the default) — `<repo>/.red/tmp/workers/…`, flat, with the
 *     worktree as its direct child. It needs no per-repository segmentation
 *     because it is already inside the repository.
 *   - `tmp`  — `/tmp/.redskilled/repositories/<slug>/workers/…`
 *   - `host` — `~/.red/redskilled/repositories/<slug>/workers/…`, under the
 *     daemon's own home, which `redskilled` owns and creates (ADR 0130
 *     Amendment 2). This module names that root, it never brings it into being.
 *
 * The two shared presets segment by repository under the deterministic slug from
 * `project-identity.ts`, so the whole machine lists with one directory listing.
 * A free-form value names the PARENT DIRECTORY OF WORKERS, never the Worker
 * directory itself.
 *
 * A closed set rather than a free path is the house pattern: ADR 0098 requires
 * every writer to use a named lane and forbids loose files under the tmp tier,
 * and a lane NAME is also what a statusline can show without rendering a whole
 * path. An unknown preset is therefore a config error, never a silent fallback —
 * a silent fallback would place Workers somewhere the operator did not choose
 * and never say so.
 *
 * ── The refusal is load-bearing ──
 *
 * A target on a MEMORY-BACKED filesystem is refused outright. A worktree plus
 * its installed dependencies held in RAM would consume the very budget the
 * daemon exists to protect, so the daemon would be financing the incident it was
 * built to prevent. A target subject to AUTOMATIC CLEANUP is refused for a
 * blunter reason: it would delete a live Worker's worktree.
 *
 * Refused, not warned about — a warning about a target the operator has already
 * declared is a message nobody reads until the incident it predicted.
 *
 * The decision layer is PURE. It reads no filesystem, no environment and no
 * process: the caller collects FACTS about the target (`/proc/mounts`, the
 * host's `tmpfiles.d` config) and hands them in, so both the layout and the
 * refusal stay testable as tables. The parsers for those facts live here too and
 * are equally pure — they take the declaring TEXT, not a path to read.
 */

/** The closed set of preset names. `local` is the default. */
export const WORKSPACE_PRESETS = ["local", "tmp", "host"] as const;
export type WorkspacePreset = (typeof WORKSPACE_PRESETS)[number];

/** The preset used when nothing is declared: workspaces stay in the repository. */
export const DEFAULT_WORKSPACE_PRESET: WorkspacePreset = "local";

/** The config key holding the declared preset name or custom parent directory. */
export const WORKSPACE_TARGET_CONFIG_KEY = "plugins.dev.workspace.target";

/** Root of the `tmp` preset when the caller does not override it. */
export const DEFAULT_TMP_ROOT = "/tmp";

/** The directory name every shared preset segments repositories under. */
const REPOSITORIES_SEGMENT = "repositories";

/** The lane's leaf: the parent of Worker directories, in every layout. */
const WORKERS_SEGMENT = "workers";

/** A Worker's git worktree is the conventional direct child (ADR 0105). */
const WORKTREE_SEGMENT = "worktree";

/**
 * Filesystem types that live in RAM. `tmpfs` and `ramfs` are the two a target
 * realistically lands on; `devtmpfs` and `rootfs` are listed because a
 * misconfigured target can resolve onto them and they are no less memory-backed
 * for being unusual.
 */
export const MEMORY_BACKED_FILESYSTEMS = ["tmpfs", "ramfs", "devtmpfs", "rootfs", "ramdisk"] as const;

/** A declared workspace target, after parsing — one of the presets, or a parent directory. */
export type WorkspaceTarget =
  | { readonly kind: "preset"; readonly preset: WorkspacePreset }
  | { readonly kind: "custom"; readonly parentDir: string };

/** Raised when the declared target is off-contract. Never downgraded to a fallback. */
export class WorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConfigError";
  }
}

/**
 * Read the declared workspace target from the TEXT of a `.red/config.yaml`.
 * Returns `undefined` when the key is absent or blank, which the parser reads as
 * "the operator declared nothing" and resolves to {@link DEFAULT_WORKSPACE_PRESET}.
 */
export function declaredWorkspaceTargetInConfig(text: string): string | undefined {
  const raw = flatConfigValue(text, WORKSPACE_TARGET_CONFIG_KEY);
  const value = unquote(raw ?? "").trim();
  return value === "" ? undefined : value;
}

/**
 * Parse a declared value into a {@link WorkspaceTarget}.
 *
 * A preset name matches the closed set, case-insensitively. Anything absolute
 * (or `~`-rooted) is a custom parent directory. Everything else — a typo, a
 * relative path, a name that only looks like a preset — throws: a Worker's
 * parent is never resolved against a working directory, and a near-miss preset
 * must fail where it was written rather than land somewhere unexpected.
 */
export function parseWorkspaceTarget(value: string | undefined): WorkspaceTarget {
  const raw = (value ?? "").trim();
  if (raw === "") return { kind: "preset", preset: DEFAULT_WORKSPACE_PRESET };

  const preset = WORKSPACE_PRESETS.find((name) => name === raw.toLowerCase());
  if (preset) return { kind: "preset", preset };

  if (raw.startsWith("/") || raw === "~" || raw.startsWith("~/")) return { kind: "custom", parentDir: raw };

  throw new WorkspaceConfigError(
    `${WORKSPACE_TARGET_CONFIG_KEY}: unknown workspace target ${JSON.stringify(raw)}. ` +
      `Use one of the presets (${WORKSPACE_PRESETS.join(", ")}) or an absolute parent directory for Workers.`,
  );
}

export interface WorkspaceLayoutInput {
  /** The declared target, already parsed. */
  readonly target: WorkspaceTarget;
  /** Absolute path of the repository root (the directory that CONTAINS `.red`). */
  readonly repoRoot: string;
  /** The project's filesystem slug (`resolveProjectIdentity().slug`); segmented presets require it. */
  readonly slug?: string;
  /** The operator's home directory — expands the `host` preset and a `~` custom value. */
  readonly homeDir: string;
  /** Root of the `tmp` preset. Defaults to {@link DEFAULT_TMP_ROOT}. */
  readonly tmpRoot?: string;
}

export interface WorkspaceLayout {
  /** The lane NAME, as a statusline shows it: a preset name, or `custom`. */
  readonly lane: WorkspacePreset | "custom";
  /** The parent directory of Workers — the lane itself, never a Worker directory. */
  readonly workersDir: string;
  /** Whether this lane segments by repository under the project slug. */
  readonly segmented: boolean;
}

/** Resolve the declared target into the concrete lane it names. */
export function resolveWorkspaceLayout(input: WorkspaceLayoutInput): WorkspaceLayout {
  if (input.target.kind === "custom") {
    return { lane: "custom", workersDir: expandHome(input.target.parentDir, input.homeDir), segmented: false };
  }

  const preset = input.target.preset;
  if (preset === "local") {
    // Already inside the repository, so there is nothing to segment it from.
    return { lane: "local", workersDir: repoWorkersDir(input.repoRoot), segmented: false };
  }

  const slug = (input.slug ?? "").trim();
  if (slug === "") {
    throw new WorkspaceConfigError(
      `${WORKSPACE_TARGET_CONFIG_KEY}: the ${preset} preset segments by repository and needs a project slug.`,
    );
  }

  // The `host` root is NAMED here and created elsewhere: the home is the
  // daemon's (ADR 0130 Amendment 2), so this layer reads `redskilledHomeDir`
  // rather than spelling the path a second time.
  const root = preset === "tmp"
    ? join(input.tmpRoot ?? DEFAULT_TMP_ROOT, ".redskilled")
    : redskilledHomeDir(input.homeDir);
  return { lane: preset, workersDir: join(root, REPOSITORIES_SEGMENT, slug, WORKERS_SEGMENT), segmented: true };
}

/**
 * Whether a declared target READS the daemon's host-scoped home.
 *
 * The home is created by its one owner (`provisionRedskilledHome`, ADR 0130
 * Amendment 2) and read by exactly one thing: a workspace lane rooted inside it.
 * With the default `local` preset nothing ever reads it, which is why creating it
 * unconditionally left operators with an empty directory and put `/red-setup` on
 * the critical path of a daemon that never touches it (#2958).
 *
 * A custom parent directory counts when it lands INSIDE the home — an operator
 * who spells the path out by hand needs it to exist no less than one who names
 * the preset.
 */
export function workspaceReadsRedskilledHome(target: WorkspaceTarget, homeDir: string): boolean {
  if (target.kind === "preset") return target.preset === "host";
  return isWithin(expandHome(target.parentDir, homeDir), redskilledHomeDir(homeDir));
}

/**
 * One Worker's workspace: `<workersDir>/<workerId>/<ticket>` — the flat layout
 * of ADR 0103, identical in every lane, because only the PARENT changes.
 */
export function workerWorkspaceDir(layout: WorkspaceLayout, workerId: string, ticket: string): string {
  return join(layout.workersDir, laneSegment(workerId, "worker id"), laneSegment(ticket, "ticket"));
}

/** A Worker's git worktree, the conventional direct child of its workspace. */
export function workerWorktreeDir(layout: WorkspaceLayout, workerId: string, ticket: string): string {
  return join(workerWorkspaceDir(layout, workerId, ticket), WORKTREE_SEGMENT);
}

/** Why a target was refused. Both reasons are refusals, never warnings. */
export type WorkspaceRefusalReason = "memory-backed-filesystem" | "automatic-cleanup";

/** What the caller observed about the target directory (or its nearest existing ancestor). */
export interface WorkspaceTargetFacts {
  /** The path the facts describe — reported back in the refusal so it names something real. */
  readonly path: string;
  /** The mounted filesystem type, e.g. `ext4`, `tmpfs`. Unknown when absent. */
  readonly filesystemType?: string;
  /** Whether the host declares this path subject to automatic cleanup. */
  readonly autoCleaned?: boolean;
}

export interface WorkspaceRefusal {
  readonly reason: WorkspaceRefusalReason;
  readonly lane: WorkspaceLayout["lane"];
  readonly path: string;
  readonly message: string;
}

/** Raised by {@link assertWorkspaceTargetUsable}. Carries the structured refusal. */
export class WorkspaceRefusalError extends Error {
  readonly refusal: WorkspaceRefusal;

  constructor(refusal: WorkspaceRefusal) {
    super(refusal.message);
    this.name = "WorkspaceRefusalError";
    this.refusal = refusal;
  }
}

/** True when a filesystem type names memory rather than a disk. */
export function isMemoryBackedFilesystem(fsType: string | undefined): boolean {
  const normalized = (fsType ?? "").trim().toLowerCase();
  return MEMORY_BACKED_FILESYSTEMS.some((known) => known === normalized);
}

/**
 * The refusal decision: the memory-backed reason is reported first when a target
 * is both, because it is the one that costs the machine rather than the work.
 * Returns `undefined` for a target that may be used.
 */
export function refuseWorkspaceTarget(
  layout: WorkspaceLayout,
  facts: WorkspaceTargetFacts,
): WorkspaceRefusal | undefined {
  if (isMemoryBackedFilesystem(facts.filesystemType)) {
    return {
      reason: "memory-backed-filesystem",
      lane: layout.lane,
      path: facts.path,
      message:
        `workspace lane ${layout.lane}: refusing ${facts.path} — it is on a memory-backed filesystem ` +
        `(${facts.filesystemType}). A worktree and its installed dependencies would be held in RAM, spending the ` +
        `very memory budget the daemon exists to protect.`,
    };
  }
  if (facts.autoCleaned === true) {
    return {
      reason: "automatic-cleanup",
      lane: layout.lane,
      path: facts.path,
      message:
        `workspace lane ${layout.lane}: refusing ${facts.path} — it is subject to automatic cleanup, ` +
        `which would delete a live Worker's worktree.`,
    };
  }
  return undefined;
}

/** {@link refuseWorkspaceTarget}, as a throw. A refused target never proceeds. */
export function assertWorkspaceTargetUsable(layout: WorkspaceLayout, facts: WorkspaceTargetFacts): void {
  const refusal = refuseWorkspaceTarget(layout, facts);
  if (refusal) throw new WorkspaceRefusalError(refusal);
}

/**
 * The filesystem type mounted at `path`, from the TEXT of `/proc/mounts` (or
 * `/etc/mtab`). The LONGEST matching mount point wins, which is what makes a
 * nested mount report itself rather than its parent.
 */
export function mountedFilesystemType(procMountsText: string, path: string): string | undefined {
  const target = normalizePath(path);
  let best: { readonly point: string; readonly type: string } | undefined;
  for (const line of procMountsText.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    const point = normalizePath(unescapeMountField(fields[1]!));
    if (point === "" || !isWithin(target, point)) continue;
    if (best === undefined || point.length > best.point.length) best = { point, type: fields[2]! };
  }
  return best?.type;
}

/**
 * The directories a `tmpfiles.d` config declares for AGE-BASED sweeping — the
 * mechanism that deletes files under `/tmp` on a running system.
 *
 * Only the directory types (`d`, `D`, `v`, `q`, `Q`) with an Age field that is
 * not `-` sweep their contents; a `-` age means "create it, never clean it", and
 * the ignore types (`x`, `X`) declare the opposite of a sweep.
 */
export function parseTmpfilesCleanupPaths(configTexts: readonly string[]): ReadonlySet<string> {
  const swept = new Set<string>();
  for (const text of configTexts) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const fields = trimmed.split(/\s+/);
      if (fields.length < 6) continue;
      // Leading `+!=-~` are modifiers on the type letter, not part of it.
      const type = fields[0]!.replace(/[+!=\-~]/g, "");
      if (!/^[dDvqQ]$/.test(type)) continue;
      const age = fields[5]!;
      if (age === "-") continue;
      const point = normalizePath(unescapeMountField(fields[1]!));
      if (point !== "") swept.add(point);
    }
  }
  return swept;
}

/** True when `path` is one of the swept directories, or lives under one. */
export function isUnderAutomaticCleanup(path: string, sweptPaths: ReadonlySet<string>): boolean {
  const target = normalizePath(path);
  for (const swept of sweptPaths) {
    if (isWithin(target, swept)) return true;
  }
  return false;
}

/** A single lane segment: never empty, never a separator, never a traversal. */
function laneSegment(value: string, label: string): string {
  const segment = value.trim();
  if (segment === "" || segment === "." || segment === ".." || /[/\\]/.test(segment)) {
    throw new WorkspaceConfigError(`invalid ${label} ${JSON.stringify(value)}: it would escape the workspace lane.`);
  }
  return segment;
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return normalizePath(homeDir);
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return normalizePath(value);
}

/** True when `path` is `ancestor` itself or sits beneath it — boundary-aware, so
 * `/tmpfoo` is not under `/tmp`. */
function isWithin(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  return ancestor === "/" ? path.startsWith("/") : path.startsWith(`${ancestor}/`);
}

/** Trailing separators dropped so one directory spelled two ways compares equal.
 * Deliberately NOT `path.resolve`: resolving would consult `process.cwd()`. */
function normalizePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** `/proc/mounts` and `tmpfiles.d` escape space, tab, newline and backslash as
 * octal, which is how a mount point containing a space is spelled. */
function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Strip one layer of surrounding quotes from a scalar YAML value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}
