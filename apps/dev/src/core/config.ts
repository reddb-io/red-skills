import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AgentEffort } from "./execution.js";
import { toAgentRunner } from "./runner-spec.js";
import type { Runner } from "../types/runner.js";

/**
 * config.ts — TypeScript port of scripts/config.sh.
 *
 * Loads the dev config from `.red/config.yaml`. Per ADR 0042 the canonical
 * location is the namespaced `plugins.dev.afk.*` block; the legacy top-level
 * `afk.*` block is still read as a back-compat fallback. `loadConfig` folds the
 * namespaced keys down to the bare `afk.*` accessor keys (the namespaced
 * location wins when both are present), so every `getConfig(cfg, "afk.…")`
 * caller is unchanged. Mirrors the shell loader's semantics exactly:
 *   - documented v1 defaults seed the map;
 *   - a missing file leaves all defaults;
 *   - malformed YAML emits one warning and falls back to all defaults;
 *   - unknown keys parse fine (forward compatibility) but are never read by
 *     any documented accessor.
 *
 * The parser is the same constrained subset the shell uses (nested mappings
 * keyed by `[a-zA-Z_][a-zA-Z0-9_-]*` with 2-space indentation, scalar leaves
 * only). No yaml dependency. All values round-trip as raw strings, matching
 * `config_get` in the shell — callers compare against literals like "false".
 */

/** Documented v1 defaults — the only way to expand the schema. */
export const CONFIG_DEFAULTS = {
  "afk.default_runner": "claude",
  "afk.fleet.target": "2",
  // AFK model-tier table (ADR 0049). The default task class is `think`, so a
  // repo with no config still runs Claude Code on opus/high, matching today's
  // behaviour while making the model+effort pair overrideable per runner/tier.
  "afk.models.claude.validate.model": "claude-haiku-4-5",
  "afk.models.claude.validate.effort": "low",
  "afk.models.claude.simple.model": "claude-sonnet-4-6",
  "afk.models.claude.simple.effort": "high",
  "afk.models.claude.complex.model": "claude-opus-4-8",
  "afk.models.claude.complex.effort": "medium",
  "afk.models.claude.think.model": "claude-opus-4-8",
  "afk.models.claude.think.effort": "high",
  "afk.models.codex.validate.model": "gpt-5.5",
  "afk.models.codex.validate.effort": "low",
  "afk.models.codex.simple.model": "gpt-5.5",
  "afk.models.codex.simple.effort": "high",
  "afk.models.codex.complex.model": "gpt-5.5",
  "afk.models.codex.complex.effort": "medium",
  "afk.models.codex.think.model": "gpt-5.5",
  "afk.models.codex.think.effort": "high",
  // OpenCode tiers (ADR 0059). The model is OpenCode's own
  // `<provider>/<model>` slug — the leading segment tells OpenCode which
  // OpenAI-compatible endpoint to dispatch to (`openrouter/...`, `openai/...`,
  // `minimax/...`, …). Auth is environment-driven: AFK propagates the first
  // set key of `OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`
  // (see `opencode-env.ts`) through `OpenCodeOptions.env`; OpenCode owns
  // endpoint resolution from there. The default slugs route through
  // OpenRouter for back-compat with the #626 contract; operators override per
  // repo under `plugins.dev.afk.models.opencode.<tier>.*` to point at any
  // OpenAI-compatible endpoint (e.g. `openai/gpt-4o-mini`,
  // `minimax/MiniMax-M3`).
  "afk.models.opencode.validate.model": "openrouter/anthropic/claude-3.5-haiku",
  "afk.models.opencode.validate.effort": "low",
  "afk.models.opencode.simple.model": "openrouter/anthropic/claude-sonnet-4",
  "afk.models.opencode.simple.effort": "high",
  "afk.models.opencode.complex.model": "openrouter/anthropic/claude-opus-4",
  "afk.models.opencode.complex.effort": "medium",
  "afk.models.opencode.think.model": "openrouter/anthropic/claude-opus-4",
  "afk.models.opencode.think.effort": "high",
  // claude-minimax runner: every tier resolves to MiniMax-M3 via the Anthropic-compat
  // endpoint (execution.ts forces the model + caps effort to "low" regardless of what
  // the tier table says; the table entries keep RED_AFK_MODEL override semantics intact).
  "afk.models.claude-minimax.validate.model": "MiniMax-M3",
  "afk.models.claude-minimax.validate.effort": "low",
  "afk.models.claude-minimax.simple.model": "MiniMax-M3",
  "afk.models.claude-minimax.simple.effort": "low",
  "afk.models.claude-minimax.complex.model": "MiniMax-M3",
  "afk.models.claude-minimax.complex.effort": "low",
  "afk.models.claude-minimax.think.model": "MiniMax-M3",
  "afk.models.claude-minimax.think.effort": "low",
  "afk.hooks.defaults.cargo": "true",
  "afk.hooks.defaults.gradle": "true",
  // Feedback-gate base rebase (AFK runner improvement, Pattern 2). When true,
  // a freshly materialised worker worktree is rebased onto the session base
  // BEFORE the gate runs, so a worker test written against a now-moved base
  // (the wPB6F/wQYIB CLAUDE_CODE_SIMPLE drift) validates against the latest
  // source rather than failing on stale expectations. Best-effort: a rebase
  // conflict aborts and the gate runs un-rebased (the baseline probe then
  // downgrades the resulting pre-existing failure). OFF by default — a repo
  // that pins per-issue bases (issue body pinning to a non-main branch) must
  // leave it off, since the session-level base would rebase onto the wrong
  // ref. Safe to enable for repos whose issues all target one trunk.
  "afk.feedback.rebase_on_base": "false",
  // Merge-gate policy (ADR 0048). The unlocked admin-merge ignores advisory
  // review checks by default — the binding gates are `drift-guard` (the
  // pre_merge hook) + in-process backpressure/feedback. Opt into waiting for an
  // advisory reviewer to conclude (it stays advisory: AFK waits, then merges
  // regardless of the verdict) with `afk.merge.wait_for_review: true`.
  "afk.merge.wait_for_review": "false",
  "afk.merge.review_check": "CodeRabbit",
  // CI-aware merge (#812). An UNLOCKED admin-merge cannot bypass required status
  // checks on an `enforce_admins` base, so admin-merging a just-opened PR with
  // checks pending is rejected — and was mislabelled `merge-conflict`, re-running
  // the whole inner agent. Opt in with `afk.merge.ci_aware: true` to first poll
  // the PR's merge state (`mergeStateStatus` + `statusCheckRollup`) and merge only
  // once it settles, routing a failed check (`blocked:ci`) / still-pending checks
  // distinctly. The wait budget is `RED_AFK_MERGE_CI_TIMEOUT_S` (default 1800s).
  "afk.merge.ci_aware": "false",
  // Landing-mode flag, decoupled from the branch-lock (ADR 0030 amended, #842).
  // The branch-lock now ONLY resolves the target base (lock > pin > main, ADR
  // 0031); this flag — independently — decides whether the attempt lands via an
  // admin-merged PR (`true`, default) or a direct merge (`false`). So: no lock +
  // true → admin-PR to main (today's unlocked); no lock + false → direct merge
  // to main (offline); lock=X + true → admin-PR to X; lock=X + false → direct
  // merge to X (today's locked). How a PR merges stays governed by `afk.merge.*`.
  // Resolved from the namespaced `plugins.dev.afk.*` block with the legacy bare
  // `afk.*` fallback (ADR 0042), like every other accessor here.
  "afk.worktree_launches_pull_request": "true",
  // PR review gate (ADR 0064 §10, #749). When AFK / `/ship` open a PR for a
  // completed attempt, the issue-classifier tier decides mechanical vs
  // non-mechanical: non-mechanical changes get `ready-for-review` (firing the
  // advisory review) and hold the merge; mechanical/trivial work keeps the
  // fast-merge path. Off by default so the autonomous loop's "merge fast / no
  // drift" behaviour is unchanged until a repo opts in. `threshold` is the
  // cheapest tier counted as non-mechanical (validate|simple|complex|think).
  "afk.review_gate.enabled": "false",
  "afk.review_gate.threshold": "complex",
  // Release channel the ADR 0038 launcher tracks (ADR 0058). `stable` is the
  // version-pinned release (today's behaviour); `canary` tracks npm's canary
  // dist-tag. The launcher reads this (or `RED_SKILLS_CHANNEL`); moving canary is
  // gated on the proof-by-drain telemetry.
  "afk.release.channel": "stable",
  // Cross-host stale-claim reaper (#1187). A running issue whose claim marker
  // stopped refreshing is released only after the stale window AND this minimum
  // grace have both elapsed; a recent commit on an `afk/*/<issue>-*` live branch
  // protects the worker for `recent_commit_s` even when the claim marker is old.
  "afk.claim_reaper.refresh_s": "300",
  "afk.claim_reaper.stale_tolerance": "3",
  "afk.claim_reaper.grace_s": "300",
  "afk.claim_reaper.recent_commit_s": "2700",
  // Warm worktree-pool model (treehouse, ADR Track 1B / issue #909). When false
  // (default) AFK uses today's cold per-attempt worktree (`git worktree add` +
  // submodule init + deps install every attempt). When true, attempts ACQUIRE a
  // warm, dependency-preserving worktree from a pool by LEASE and RETURN it on
  // completion (not destroy), so the red-castle submodule checkout and
  // `node_modules` survive into the next lease — removing the lost-deps /
  // submodule-not-init false-`blocked:validation` footgun and the cold setup
  // cost. `max_size` caps the live pool; `lease_ttl_s` reclaims a lease whose
  // holder pid died or that outlived the TTL; `min_idle_s` is the idle floor a
  // clean/merged worktree must sit before the safe pruner may remove it.
  "afk.worktree_pool.enabled": "false",
  "afk.worktree_pool.max_size": "4",
  "afk.worktree_pool.lease_ttl_s": "3600",
  "afk.worktree_pool.min_idle_s": "1800",
  // Companion (active) monitor drift thresholds (#921). The opt-in
  // `monitor --companion` pass reads these (folded from
  // `plugins.dev.afk.companion.*`) to tune when a live worker is judged to be
  // DRIFTING — churning iterations without producing work, wedged waiting, or
  // sprawling far past the issue's scope. Mirror DEFAULT_COMPANION_THRESHOLDS in
  // core/companion.ts; conservative on purpose so the companion only fires on
  // clear drift. The flag, not a config key, gates the whole pass (off →
  // read-only dashboard, no writes), so there is no `companion.enabled` here.
  "afk.companion.iteration_churn": "8",
  "afk.companion.waiting_windows": "20",
  "afk.companion.diff_drift_loc": "4000",
  "afk.companion.min_progress_loc": "5",
  // Intra-attempt notes-loop (Track C, #924). Opt-in outer loop that wraps the
  // single inner-agent invocation: each iteration makes one small committed
  // change, then the loop re-invokes the agent seeded with an accumulated
  // `notes.md` (carried at the attempt dir, never committed to the worker
  // branch) until the agent signals DONE or a cap trips (partial work is then
  // salvaged + landed). OFF by default → exactly one agent call, today's
  // behaviour. Caps (folded from `plugins.dev.afk.notes_loop.*`, mirror
  // NOTES_LOOP_DEFAULT_* in core/notes-loop.ts): `max_iterations` = outer
  // re-invocation ceiling; `inner_max_iterations` = the per-iteration sandcastle
  // re-invocation ceiling (0 → leave the run's own default); `token_budget` =
  // cumulative input+output token ceiling checked BETWEEN iterations (0 →
  // unlimited); `wall_clock_s` = wall-clock ceiling checked between iterations
  // (0 → unlimited). The between-iteration checks never double-abort with the
  // per-call attempt guard, which owns aborting a single in-flight iteration.
  "afk.notes_loop.enabled": "false",
  "afk.notes_loop.max_iterations": "4",
  "afk.notes_loop.inner_max_iterations": "0",
  "afk.notes_loop.token_budget": "0",
  "afk.notes_loop.wall_clock_s": "0",
  // Spec cascade rebase (issue #1007). After a successful DONE landing, rebase
  // every open sibling branch (same spec:N, not held by a live worker) onto the
  // new base HEAD so the next worker to pick up a sibling starts from a
  // near-current base. Best-effort: a per-branch failure is logged as a warning
  // and never rolls back the primary landing. Set "false" to opt out.
  "afk.landing.cascade_rebase": "true",
  "dev.lock.primary-branch": "false",
  // External-PR request surface for `/triage` (issue #1298). Off by default:
  // when unset/false, triage discovery and routing are issue-only. Enabling the
  // surface only lets `/triage` inspect external PR metadata/diffs as untrusted
  // request data; execution-shaped work stays behind the normal trust gate.
  "dev.triage.external_pr_surface.enabled": "false",
  // The Trunk (ADR 0083): the repo's configured focal branch — the default
  // base every AFK worktree forks from and the default target a landing
  // integrates into, when neither a branch lock nor a pin names one
  // (precedence lock > pin > trunk). Always consumed as its fresh-fetched
  // remote ref (`origin/<trunk>`), never as the local working-tree branch.
  // Set `plugins.dev.trunk` (folds to this accessor) to move the focal branch
  // to e.g. `develop` or `workspace/<user>`.
  "dev.trunk": "main",
  // NOTE: `dev.lock.branch` (the static base lock — ADR 0031) is intentionally
  // NOT in this table. Its "default" is *unset* (no config-level lock), and
  // `getConfig` already returns "" for an absent key, so adding a "" default
  // here would only break the "every default is non-empty" invariant. It is read
  // via `getConfig(values, "dev.lock.branch")` and documented in config-template.yaml.
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;

export const AFK_MODEL_TIERS = ["validate", "simple", "complex", "think"] as const;
export type AfkModelTier = (typeof AFK_MODEL_TIERS)[number];

const AFK_MODEL_TIER_ORDER: readonly AfkModelTier[] = AFK_MODEL_TIERS;

/** One-step downgrade in the model-tier-policy vocabulary. The cheapest tier is
 * already the floor, so it stays `validate`. */
export function downgradeAfkModelTier(tier: AfkModelTier): AfkModelTier {
  const idx = AFK_MODEL_TIER_ORDER.indexOf(tier);
  return idx <= 0 ? "validate" : AFK_MODEL_TIER_ORDER[idx - 1]!;
}

export interface ResolvedTier {
  model: string;
  effort: AgentEffort;
}

const AGENT_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Every value in the flat config map is a raw string, like the shell's `config_get`. */
export const ConfigValuesSchema = z.record(z.string());
export type ConfigValues = z.infer<typeof ConfigValuesSchema>;

/** Thrown by `parseConfigYaml` when the input violates the tiny-YAML grammar. */
export class MalformedConfigError extends Error {
  constructor(message = "malformed YAML") {
    super(message);
    this.name = "MalformedConfigError";
  }
}

function configDefaults(): ConfigValues {
  return { ...CONFIG_DEFAULTS };
}

/**
 * Parse the constrained-subset YAML into `dotted.key -> value` entries.
 *
 * Pure: takes the file's text, returns the flat map of scalar leaves. Throws
 * `MalformedConfigError` on grammar violations (odd indentation, a non-mapping
 * line, or an unclosed quoted string) — exactly the cases where the shell
 * parser returns non-zero.
 */
export function parseConfigYaml(text: string): ConfigValues {
  const out: ConfigValues = {};
  const stack: string[] = [];
  const indents: number[] = [];
  // Per-parent running index for block-sequence items (`- value`). A sequence
  // under the dotted parent path `p` materialises as `p.0`, `p.1`, … so the
  // flat config map keeps its `dotted.key -> value` shape (see readBackpressure).
  const seqCounters: Record<string, number> = {};

  for (let raw of text.split("\n")) {
    // strip a trailing CR (CRLF tolerance)
    raw = raw.replace(/\r$/, "");

    // strip inline comments unless the line contains a quoted string
    let stripped = raw;
    if (!/".*"/.test(stripped) && !/'.*'/.test(stripped)) {
      const hash = stripped.indexOf("#");
      if (hash >= 0) stripped = stripped.slice(0, hash);
    }

    // skip blank / whitespace-only lines
    if (stripped.replace(/\s/g, "") === "") continue;

    const indentStr = stripped.match(/^\s*/)?.[0] ?? "";
    const indent = indentStr.length;
    if (indent % 2 !== 0) throw new MalformedConfigError();

    let rest = stripped.slice(indent).replace(/\s+$/, "");

    // Block-sequence item: `- value` under the current mapping key. Pop parents
    // whose indent is >= this line's, exactly like the mapping branch, then
    // append the scalar at `<parent>.<index>`. A sequence with no enclosing
    // mapping key (empty stack) or an empty item is malformed.
    if (/^-(\s|$)/.test(rest)) {
      while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
        stack.pop();
        indents.pop();
      }
      if (stack.length === 0) throw new MalformedConfigError();

      let item = rest.slice(1).replace(/^\s+/, "");
      if (item === "") throw new MalformedConfigError();
      // Strip an inline comment that follows the closing quote (e.g. `- "cmd" # note`).
      if (item[0] === '"' || item[0] === "'") {
        const q = item[0];
        const close = item.indexOf(q, 1);
        if (close > 0) {
          const tail = item.slice(close + 1).trimStart();
          if (tail === "" || tail.startsWith("#")) item = item.slice(0, close + 1);
        }
      }
      if (item.startsWith('"')) {
        if (!item.endsWith('"') || item.length < 2) throw new MalformedConfigError();
        item = item.slice(1, -1);
      } else if (item.startsWith("'")) {
        if (!item.endsWith("'") || item.length < 2) throw new MalformedConfigError();
        item = item.slice(1, -1);
      }

      const parent = stack.join(".");
      const idx = seqCounters[parent] ?? 0;
      seqCounters[parent] = idx + 1;
      out[`${parent}.${idx}`] = item;
      continue;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(rest)) throw new MalformedConfigError();

    const colon = rest.indexOf(":");
    const key = rest.slice(0, colon);
    let value = rest.slice(colon + 1).replace(/^\s+/, "");

    // Strip an inline comment that follows the closing quote (e.g. `key: "v" # note`).
    if (value[0] === '"' || value[0] === "'") {
      const q = value[0];
      const close = value.indexOf(q, 1);
      if (close > 0) {
        const tail = value.slice(close + 1).trimStart();
        if (tail === "" || tail.startsWith("#")) value = value.slice(0, close + 1);
      }
    }
    // unclosed-quote detection / strip matching quotes
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) throw new MalformedConfigError();
      value = value.slice(1, -1);
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new MalformedConfigError();
      value = value.slice(1, -1);
    }

    // pop parents whose indent is >= current
    while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
      stack.pop();
      indents.pop();
    }

    const full = stack.length > 0 ? `${stack.join(".")}.${key}` : key;

    if (value === "") {
      stack.push(key);
      indents.push(indent);
    } else {
      out[full] = value;
    }
  }

  return out;
}

/** Injectable file reader. Returns the file's text, or `undefined` if absent. */
export type ConfigReader = (path: string) => string | undefined;

/** Injectable warning sink, defaulting to stderr like the shell loader. */
export type ConfigWarn = (message: string) => void;

export interface LoadConfigOptions {
  read?: ConfigReader;
  warn?: ConfigWarn;
}

const defaultReader: ConfigReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const defaultWarn: ConfigWarn = (message) => {
  process.stderr.write(`${message}\n`);
};

/**
 * Load config from `path`, merging file overrides onto the v1 defaults.
 *
 * Mirrors `config_load`:
 *   - missing file → all defaults, no warning;
 *   - malformed YAML → exactly one warning mentioning the path, all defaults;
 *   - well-formed file → defaults overlaid with every parsed key (including
 *     unknown ones, for forward compatibility).
 */
export function loadConfig(path: string, options: LoadConfigOptions = {}): ConfigValues {
  const read = options.read ?? defaultReader;
  const warn = options.warn ?? defaultWarn;

  const values = configDefaults();
  const text = read(path);
  if (text === undefined) return values;

  let parsed: ConfigValues;
  try {
    parsed = parseConfigYaml(text);
  } catch {
    warn(`[afk:config] warn: malformed YAML in ${path} — using defaults`);
    return configDefaults();
  }

  // Copy raw parsed keys (forward compatibility), then fold the namespaced
  // `plugins.dev.*` block down to the accessor keys so the new location wins over
  // the legacy top-level one (ADR 0042).
  // Track which accessor keys the user explicitly set — needed by resolveTier to
  // distinguish "user pinned a tier to the same value as the default" (should win
  // over legacy scalars) from "tier is just the CONFIG_DEFAULTS value" (should fall
  // through to base/scalar fallbacks). Stored as a null-byte-keyed side-channel
  // that can never originate from YAML (null bytes are invalid YAML key chars).
  const explicitAccessorKeys = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    values[key] = value;
    explicitAccessorKeys.add(key);
  }
  for (const [key, value] of Object.entries(parsed)) {
    const m = /^plugins\.dev\.(.+)$/.exec(key);
    if (!m) continue;
    const rest = m[1]!;
    // The dev plugin's AFK settings flatten to the bare `afk.*` accessor
    // (historical, shared with the legacy top-level `afk:` block); every other
    // dev-plugin key keeps the `dev.*` accessor — so
    // `plugins.dev.lock.primary-branch` folds to `dev.lock.primary-branch`, not a
    // bare `lock.primary-branch` the loader never reads.
    const accessorKey = rest === "afk" || rest.startsWith("afk.") ? rest : `dev.${rest}`;
    values[accessorKey] = value;
    explicitAccessorKeys.add(accessorKey);
  }
  if (explicitAccessorKeys.size > 0) {
    values["\0explicit"] = Array.from(explicitAccessorKeys).join("\x01");
  }
  return values;
}

/** Read a dotted key. Empty string when unset — same contract as `config_get`. */
export function getConfig(values: ConfigValues, key: string): string {
  return values[key] ?? "";
}

function defaultTierKey(runner: string, tier: AfkModelTier, field: "model" | "effort"): ConfigKey | undefined {
  const key = `afk.models.${runner}.${tier}.${field}`;
  return Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key) ? (key as ConfigKey) : undefined;
}

function readEffort(raw: string, fallback: AgentEffort): AgentEffort {
  return (AGENT_EFFORTS as readonly string[]).includes(raw) ? (raw as AgentEffort) : fallback;
}

/**
 * Resolve AFK's per-runner model tier (ADR 0049).
 *
 * Precedence for the model (mirrors the runner/sandbox knobs — flag and env beat
 * the file, ADR 0049):
 *   0. runtime override: `RED_AFK_MODEL` env (the `--model` run flag pre-sets it).
 *      Flattens every tier onto one slug — "use this model regardless of tier".
 *   1. explicit tier table entry: `afk.models.<runner>.<tier>.model`
 *   2. per-runner base: `afk.models.<runner>.base.model` (auto-populates every
 *      tier of the runner; a specialized `.<tier>.model` still wins over it)
 *   3. legacy runner scalar: `afk.models.<runner>`
 *   4. legacy global scalar: `afk.model`
 *   5. tier-table default
 * `RED_AFK_EFFORT` overrides effort the same way (still provider-gated downstream).
 *
 * `loadConfig` already folds `plugins.dev.afk.*` over the legacy top-level
 * `afk.*` keys (ADR 0042), so the same reader honours both locations. `env` is
 * injected (default empty) so the override is opt-in per call site — the AFK run
 * path passes `process.env`; the interactive model-tier route does not.
 */
export function resolveTier(
  values: ConfigValues,
  runner: string,
  taskClass: AfkModelTier = "think",
  env: NodeJS.ProcessEnv = {},
): ResolvedTier {
  // The runner whose tier table to read. claude/codex/opencode/claude-minimax each
  // ship a full table (CONFIG_DEFAULTS); any other runner (e.g. the runner-neutral
  // hermes) falls back to the claude table via the shared `toAgentRunner` seam.
  const tierRunner = toAgentRunner(runner as Runner);
  const requestedTier = (AFK_MODEL_TIERS as readonly string[]).includes(taskClass) ? taskClass : "think";
  const tier = env.RED_AFK_TASK_TIER_DOWNGRADE === "1"
    ? downgradeAfkModelTier(requestedTier)
    : requestedTier;
  const modelKey = defaultTierKey(tierRunner, tier, "model")!;
  const effortKey = defaultTierKey(tierRunner, tier, "effort")!;
  const defaultModel = CONFIG_DEFAULTS[modelKey];
  const defaultEffort = CONFIG_DEFAULTS[effortKey] as AgentEffort;
  const tierModel = getConfig(values, modelKey);
  // Per-runner `base` (model + effort): a structured default that auto-populates
  // every tier of this runner, so an operator can point the whole runner at one
  // provider/model with a single line and still specialize a tier by setting its
  // own `.<tier>.model`. It sits between the explicit tier entry and the legacy
  // scalars — a tier left at its table default falls back to `base`; an explicitly
  // set tier overrides it.
  const baseModel = getConfig(values, `afk.models.${tierRunner}.base.model`);
  const baseEffort = getConfig(values, `afk.models.${tierRunner}.base.effort`);
  const scalarRunnerModel = getConfig(values, `afk.models.${tierRunner}`);
  const scalarGlobalModel = getConfig(values, "afk.model");
  const tierEffort = getConfig(values, effortKey);

  // The set of accessor keys the user explicitly wrote in their YAML (tracked by
  // loadConfig). Needed to distinguish "user pinned a tier to the same value as the
  // CONFIG_DEFAULT" (must win over legacy scalars — bug #583) from "tier is just the
  // CONFIG_DEFAULT" (should fall through to base/scalar fallbacks).
  const explicitKeys = new Set<string>((values["\0explicit"] ?? "").split("\x01").filter(Boolean));

  // Runtime override: a non-empty RED_AFK_MODEL/RED_AFK_EFFORT wins over the file
  // (`""` counts as unset, so a placeholder export never flattens the tiers).
  const modelOverride = (env.RED_AFK_MODEL ?? "").trim();
  const effortOverride = (env.RED_AFK_EFFORT ?? "").trim();

  // An explicit tier pin wins when it is non-empty AND either differs from the
  // default (clearly user-set) or is known to have been user-set (even when it
  // equals the default — an explicit pin must beat legacy scalars per bug #583).
  const configModel =
    tierModel && (tierModel !== defaultModel || explicitKeys.has(modelKey))
      ? tierModel
      : baseModel || scalarRunnerModel || scalarGlobalModel || defaultModel;
  const configEffort =
    tierEffort && (tierEffort !== defaultEffort || explicitKeys.has(effortKey))
      ? tierEffort
      : baseEffort || defaultEffort;

  return {
    model: modelOverride.length > 0 ? modelOverride : configModel,
    effort:
      effortOverride.length > 0
        ? readEffort(effortOverride, defaultEffort)
        : readEffort(configEffort, defaultEffort),
  };
}

/**
 * Read the operator-declared backpressure command list (`afk.backpressure`),
 * in declaration order (issue #430). The list form
 *
 *   afk:
 *     backpressure:
 *       - npm run test
 *       - npm run lint
 *
 * materialises as the indexed keys `afk.backpressure.0`, `afk.backpressure.1`, …
 * which this reads back in order until the first gap. The namespaced
 * `plugins.dev.afk.backpressure.*` location already folds down to the bare keys
 * in {@link loadConfig} (ADR 0042), so both locations are honoured with the
 * namespaced one winning. A single-line scalar (`afk.backpressure: npm run test`)
 * is accepted as a one-command list. Absent/empty → `[]` (the gate is a no-op).
 * Blank entries are dropped.
 */
export function readBackpressure(values: ConfigValues): string[] {
  const indexed: string[] = [];
  for (let i = 0; ; i++) {
    const v = values[`afk.backpressure.${i}`];
    if (v === undefined) break;
    if (v.trim() !== "") indexed.push(v);
  }
  if (indexed.length > 0) return indexed;
  const scalar = values["afk.backpressure"];
  return scalar && scalar.trim() !== "" ? [scalar] : [];
}

/**
 * Read the operator-declared post-attempt-format command list
 * (`afk.post_attempt_format`), in declaration order (#1015). The list form
 *
 *   afk:
 *     post_attempt_format:
 *       - cargo fmt --all
 *
 * materialises as the indexed keys `afk.post_attempt_format.0`, … which this
 * reads back in order until the first gap. The namespaced
 * `plugins.dev.afk.post_attempt_format.*` location already folds down to the
 * bare keys in {@link loadConfig} (ADR 0042). A single-line scalar is accepted
 * as a one-command list. Absent/empty → `[]` (the step is a no-op).
 */
export function readPostAttemptFormat(values: ConfigValues): string[] {
  const indexed: string[] = [];
  for (let i = 0; ; i++) {
    const v = values[`afk.post_attempt_format.${i}`];
    if (v === undefined) break;
    if (v.trim() !== "") indexed.push(v);
  }
  if (indexed.length > 0) return indexed;
  const scalar = values["afk.post_attempt_format"];
  return scalar && scalar.trim() !== "" ? [scalar] : [];
}

/** Default CI-aware merge wait, in seconds (#812) — 30 minutes, generous enough
 * to outlast a slow required-check suite (e.g. reddb's 25 checks / ~25m fuzzer)
 * without wedging the worker forever. */
export const DEFAULT_MERGE_CI_TIMEOUT_S = 1800;

/**
 * Resolve the CI-aware merge wait budget (#812) from `RED_AFK_MERGE_CI_TIMEOUT_S`.
 * A non-positive / unparseable value falls back to {@link DEFAULT_MERGE_CI_TIMEOUT_S}.
 */
export function resolveCiTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RED_AFK_MERGE_CI_TIMEOUT_S ?? "").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MERGE_CI_TIMEOUT_S;
}
