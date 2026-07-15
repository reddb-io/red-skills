/**
 * red-paths.ts — the single path authority for the `.red/` directory (ADR 0098).
 *
 * Every `.red/` path — the four lifecycle tiers, every named lane from the ADR's
 * lane registry, the shared RedDB store, and the plugin store homes — derives
 * from one repo root through this module. Before this authority existed each
 * runtime spelled its own `join(root, ".red", ...)`, so a taxonomy change (the
 * shared store moving to the state tier, a lane being renamed) had to be chased
 * across every app. This module is where the ADR's layout lives in code; the
 * expand-contract migration (Spec #1681) points every call site here.
 *
 * Pure and dependency-free: builders take an explicit `root` (the directory that
 * CONTAINS `.red`), env-honoring helpers take an explicit `env`, and root
 * resolution takes an explicit `exists` probe. Nothing reads `process` or the
 * filesystem on its own, so the whole surface is unit-testable without mocks.
 *
 * This is the EXPAND half of an expand-contract chain: it adds the authority
 * with ZERO behavior change and ZERO consumers. Migrating the runtimes onto it
 * is the contract half, tracked separately.
 */
import { isAbsolute, join, resolve } from "node:path";

/** The `.red` directory name, relative to a repo root. */
export const RED_DIR = ".red";

/** Env var that overrides the ACTIVE workers lane segment (see {@link workersSegment}). */
export const WORKERS_NAMESPACE_ENV = "RED_AFK_WORKERS_NAMESPACE";

/** Env var the memory plugin reads to override its repo root. */
export const MEMORY_ROOT_ENV = "MEMORY_ROOT";

/** Env var the brain plugin reads to override its repo root. */
export const BRAIN_ROOT_ENV = "RED_BRAIN_ROOT";

/**
 * Ordered root-override env vars, first non-empty wins in {@link resolveRedRoot}.
 * Memory takes precedence over brain only because it is listed first; a caller
 * that wants a single plugin's override should pass its own `overrideEnvVars`.
 */
export const ROOT_OVERRIDE_ENV_VARS = [MEMORY_ROOT_ENV, BRAIN_ROOT_ENV] as const;

/** Strip a single trailing slash so `join` never emits a double separator. */
function normalizeRoot(root: string): string {
  if (!root) throw new Error("root is required");
  return root.replace(/\/$/, "");
}

// ── Lifecycle tiers (ADR 0098 §1) ───────────────────────────────────────────

/** Tier 1 anchor: `<root>/.red`. Tracked knowledge/config lives directly here. */
export function redDir(root: string): string {
  return join(normalizeRoot(root), RED_DIR);
}

/** The canonical plugin config file: `<root>/.red/config.yaml` (ADR 0042). */
export function configFile(root: string): string {
  return join(redDir(root), "config.yaml");
}

/** The project hooks directory: `<root>/.red/hooks`. */
export function hooksDir(root: string): string {
  return join(redDir(root), "hooks");
}

/** Tier 3: durable machine state under `<root>/.red/state`. Never mass-deletable. */
export function stateDir(root: string): string {
  return join(redDir(root), "state");
}

/** Tier 4: disposable scratch under `<root>/.red/tmp`. `rm -rf`-safe by contract. */
export function tmpDir(root: string): string {
  return join(redDir(root), "tmp");
}

/** Durable generated knowledge (not tmp, not yet repo truth): `<root>/.red/researches`. */
export function researchesDir(root: string): string {
  return join(redDir(root), "researches");
}

// ── Tier 2: plugin store homes (ADR 0098 §1) ────────────────────────────────

/** The memory plugin store home: `<root>/.red/memory`. */
export function memoryDir(root: string): string {
  return join(redDir(root), "memory");
}

/** The brain plugin store home: `<root>/.red/brain`. */
export function brainDir(root: string): string {
  return join(redDir(root), "brain");
}

/** The LLM Wiki store home: `<root>/.red/wiki`. */
export function wikiDir(root: string): string {
  return join(redDir(root), "wiki");
}

// ── State-tier lanes (ADR 0098 §2) ──────────────────────────────────────────

/** AFK supervisor state, restart counters, circuit-breakers: `.red/state/afk`. */
export function afkStateDir(root: string): string {
  return join(stateDir(root), "afk");
}

/** rsp telemetry spool / status summaries / resident metadata: `.red/state/rsp`. */
export function rspStateDir(root: string): string {
  return join(stateDir(root), "rsp");
}

/** Statusline caches that survive tmp cleanup: `.red/state/statusline`. */
export function statuslineStateDir(root: string): string {
  return join(stateDir(root), "statusline");
}

/** Local branch-lock file: `.red/state/branch-lock.yaml`. */
export function branchLockFile(root: string): string {
  return join(stateDir(root), "branch-lock.yaml");
}

/**
 * The shared RedDB store, relative to a repo root. ADR 0098 moves it to the
 * durable state tier, superseding ADR 0095's `.red/red.rdb` root location and
 * the red-setup write contract's temporary `.red/tmp/red-skills.rdb`.
 */
export const SHARED_STORE_REL = ".red/state/red-skills.rdb";

/** Absolute path to the single shared RedDB store used by memory and rsp. */
export function sharedStorePath(root: string): string {
  return join(stateDir(root), "red-skills.rdb");
}

/**
 * The pre-ADR-0098 shared store location under the disposable tmp tier. Kept as
 * a named constant so the one-time setup migration and the transition-window
 * fallback read ({@link resolveSharedStorePath}) point at the SAME legacy path
 * instead of each re-spelling `.red/tmp/red-skills.rdb`.
 */
export const LEGACY_SHARED_STORE_REL = ".red/tmp/red-skills.rdb";

/** Absolute path to the legacy (tmp-tier) shared RedDB store. */
export function legacySharedStorePath(root: string): string {
  return join(tmpDir(root), "red-skills.rdb");
}

/**
 * Resolve the shared store path a consumer should OPEN, honoring the migration
 * transition window: prefer the canonical state-tier location, fall back to the
 * legacy tmp-tier file when only that exists, and default to the state-tier path
 * when neither is present (so a fresh store is created in the new home).
 *
 * `exists` is injected so this stays pure and unit-testable without mocks.
 */
export function resolveSharedStorePath(root: string, exists: (path: string) => boolean): string {
  const primary = sharedStorePath(root);
  if (exists(primary)) return primary;
  const legacy = legacySharedStorePath(root);
  if (exists(legacy)) return legacy;
  return primary;
}

// ── Tmp-tier worker lanes (ADR 0098 §2) ─────────────────────────────────────

/**
 * The three fixed worker-lane segments under `.red/tmp/`: the `/afk` fleet lives
 * in `workers`, a `/go` dispatch in `go-workers`, a `--scout` run in
 * `scout-workers`. Read-only observability surfaces union over all three.
 */
export const WORKER_NAMESPACES = ["workers", "go-workers", "scout-workers"] as const;

/** The `/afk` fleet worker lane: `.red/tmp/workers`. */
export function workersDir(root: string): string {
  return join(tmpDir(root), "workers");
}

/** The `/go` dispatch worker lane: `.red/tmp/go-workers`. */
export function goWorkersDir(root: string): string {
  return join(tmpDir(root), "go-workers");
}

/** The `--scout` worker lane: `.red/tmp/scout-workers`. */
export function scoutWorkersDir(root: string): string {
  return join(tmpDir(root), "scout-workers");
}

/**
 * The ACTIVE workers segment for THIS process. Defaults to `workers`; a `/go` or
 * `--scout` process sets {@link WORKERS_NAMESPACE_ENV} so its worker dir lands in
 * its own lane, never colliding with the fleet's. Only a `[A-Za-z0-9_-]+` value
 * is honoured — anything else (empty, path traversal) falls back to `workers`.
 */
export function workersSegment(env: Record<string, string | undefined>): string {
  const ns = env[WORKERS_NAMESPACE_ENV];
  return ns && /^[A-Za-z0-9_-]+$/.test(ns) ? ns : "workers";
}

/** The active workers lane dir for this process, honoring the namespace override. */
export function activeWorkersDir(root: string, env: Record<string, string | undefined>): string {
  return join(tmpDir(root), workersSegment(env));
}

// ── Tmp-tier flat lanes (ADR 0098 §2) ───────────────────────────────────────

/** AFK claim locks: `.red/tmp/claims`. */
export function claimsDir(root: string): string {
  return join(tmpDir(root), "claims");
}

/** Active `rsp wait` registry: `.red/tmp/waits`. */
export function waitsDir(root: string): string {
  return join(tmpDir(root), "waits");
}

/** Free-form short-lived scratch: `.red/tmp/scratch`. */
export function scratchDir(root: string): string {
  return join(tmpDir(root), "scratch");
}

/** Dev-runtime failure diagnostics (age-capped): `.red/tmp/diagnostics`. */
export function diagnosticsDir(root: string): string {
  return join(tmpDir(root), "diagnostics");
}

/** Date-partitioned session logs: `.red/tmp/logs/<yyyy-mm-dd>`. */
export function logsDir(root: string, date: string): string {
  if (!date) throw new Error("date is required (yyyy-mm-dd)");
  return join(tmpDir(root), "logs", date);
}

// ── Tmp-tier worktree lanes (ADR 0098 §2) ───────────────────────────────────

/** Parent of every temporary worktree lane: `.red/tmp/worktrees`. */
export function worktreesDir(root: string): string {
  return join(tmpDir(root), "worktrees");
}

/** Hand-worked slice worktrees, slug-named: `.red/tmp/worktrees/manual`. */
export function manualWorktreesDir(root: string): string {
  return join(worktreesDir(root), "manual");
}

/** Feedback-gate worktree cache: `.red/tmp/worktrees/feedback`. */
export function feedbackWorktreesDir(root: string): string {
  return join(worktreesDir(root), "feedback");
}

/** Temporary landing worktrees: `.red/tmp/worktrees/landing`. */
export function landingWorktreesDir(root: string): string {
  return join(worktreesDir(root), "landing");
}

/** Temporary pre-merge rebase worktrees: `.red/tmp/worktrees/rebase`. */
export function rebaseWorktreesDir(root: string): string {
  return join(worktreesDir(root), "rebase");
}

/** Cascade rebase/follow-up worktrees: `.red/tmp/worktrees/cascade`. */
export function cascadeWorktreesDir(root: string): string {
  return join(worktreesDir(root), "cascade");
}

/** Adoption / no-agent landing worktrees: `.red/tmp/worktrees/adopt`. */
export function adoptWorktreesDir(root: string): string {
  return join(worktreesDir(root), "adopt");
}

/** Merge-conflict / boot reconcile worktrees: `.red/tmp/worktrees/reconcile`. */
export function reconcileWorktreesDir(root: string): string {
  return join(worktreesDir(root), "reconcile");
}

/** `/start` docs-finalizer landing worktrees: `.red/tmp/worktrees/docs`. */
export function docsWorktreesDir(root: string): string {
  return join(worktreesDir(root), "docs");
}

// ── Root resolution (env overrides honored) ─────────────────────────────────

export interface ResolveRedRootOptions {
  /** Where to start walking from. */
  startDir: string;
  /** Env map consulted for `overrideEnvVars`. */
  env: Record<string, string | undefined>;
  /** Existence probe for a candidate `.red` path (injected so this stays pure). */
  exists: (path: string) => boolean;
  /**
   * Ordered override env vars; the first non-empty one wins and is resolved
   * against `startDir`. Defaults to {@link ROOT_OVERRIDE_ENV_VARS} (memory,
   * brain), mirroring how those plugins honor their own root env today.
   */
  overrideEnvVars?: readonly string[];
}

/**
 * Resolve the repo root that owns `.red`, honoring the plugin root env overrides.
 *
 * 1. If any `overrideEnvVars` entry is set, resolve it against `startDir` and
 *    return it (an absolute override wins outright). This mirrors brain's
 *    `resolve(startDir, RED_BRAIN_ROOT)` and memory's `MEMORY_ROOT ?? cwd`.
 * 2. Otherwise walk UP from `startDir` for the first directory with a `.red`
 *    child and return that directory.
 * 3. If none is found, fall back to `startDir` (never throws).
 */
export function resolveRedRoot(options: ResolveRedRootOptions): string {
  const overrideVars = options.overrideEnvVars ?? ROOT_OVERRIDE_ENV_VARS;
  for (const name of overrideVars) {
    const value = options.env[name];
    if (value) return isAbsolute(value) ? value : resolve(options.startDir, value);
  }
  let current = resolve(options.startDir);
  while (true) {
    if (options.exists(join(current, RED_DIR))) return current;
    const parent = join(current, "..");
    const resolvedParent = resolve(parent);
    if (resolvedParent === current) break;
    current = resolvedParent;
  }
  return options.startDir;
}

// ── Legacy worktree classification (boot-sweep authority) ────────────────────

/**
 * How the boot sweep must treat a pre-cutover `.red/tmp/work-*` dir name:
 * - `relic` — `work-<issue-number>` (digits): the AFK orchestrator made it;
 *   reclaimable once its pid is dead.
 * - `maintainer` — `work-<slug>`: a hand-work worktree (CLAUDE.md); ALWAYS spared
 *   (guards #1052, where a fresh slug worktree was wrongly wiped).
 * - `unknown` — not a `work-<name>` dir at all; out of the sweep's scope.
 */
export type LegacyWorktreeClass = "relic" | "maintainer" | "unknown";

/** Digit-suffixed relic: `work-<issue-number>`, first digit 1-9 (a real issue #). */
const RELIC_WORK_DIR_RE = /^work-[1-9][0-9]*$/;

/** Any `work-<non-empty>` dir; distinguishes a maintainer slug from a non-work name. */
const WORK_PREFIX_RE = /^work-.+$/;

/** Classify a `.red/tmp` dir NAME (not path) for the slug-sparing boot sweep. */
export function classifyLegacyWorktreeName(name: string): LegacyWorktreeClass {
  if (RELIC_WORK_DIR_RE.test(name)) return "relic";
  if (WORK_PREFIX_RE.test(name)) return "maintainer";
  return "unknown";
}
