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
 * Two rules the loader owns on top of that, both harvested from the castle twin
 * (issue #2245):
 *   - FAIL-CLOSED IN-PROCESS (ADR 0116). A directory that has not opted into the
 *     dev plugin (`plugins.dev.enabled: true`, ADR 0067) yields the defaults and
 *     nothing else, decided HERE rather than only at process entry, so an
 *     in-process caller that bypassed the entrypoint cannot read a disabled
 *     directory's settings.
 *   - RETIRED KEYS ARE TOMBSTONED (ADR 0117). {@link DELETED_CONFIG_KEYS} names
 *     every key that USED to mean something, so a retired key is distinguishable
 *     from an unknown forward-compat one and warns instead of silently reading
 *     as inert.
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
  // Fleet cgroup isolation (#2697). On Linux with a systemd `--user` session the
  // launcher runs the supervisor inside a transient `red-fleet-<name>.scope`, so
  // `systemd-oomd` charges the fleet's memory to the fleet instead of to the
  // terminal that launched it. `memory_high` is the scope's `MemoryHigh`
  // throttle — any systemd memory value ("70%", "6G"); an empty value sets no
  // property. Set `enabled: false` (or `RED_AFK_FLEET_SCOPE=off`) to launch
  // unscoped, which the launcher then warns about rather than doing silently.
  "afk.fleet.scope.enabled": "true",
  "afk.fleet.scope.memory_high": "70%",
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
  // Serialized landing (#1337). Two workers finishing in the same window used to
  // both integrate-and-push into the base: the second push was rejected
  // non-fast-forward, and re-integrating an overlapping diff conflicted. Set
  // `afk.merge.native_queue: true` when `<base>` has the forge's merge queue — the
  // PR is then ENQUEUED (`gh pr merge --auto`) and no local lock is taken, because
  // the queue rebases + revalidates each entry onto the current tip itself.
  "afk.merge.native_queue": "false",
  // Otherwise every land takes a global land-lock at `.red/tmp/afk-land.lock`, so
  // exactly one worker per host+repo is inside the integrate → revalidate → merge →
  // push critical section. ON by default; set false only to restore the pre-#1337
  // unserialized land (single-worker fleets, where nothing can race).
  "afk.merge.land_lock": "true",
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
  // Landing-tail slot release (#2427). `merge` is the byte-compatible default:
  // the worker owns PR-open, CI, merge, and close. `ci` releases after green CI;
  // `none` releases after PR-open. The shared wait/webhook observer finishes the
  // remaining tail, with rsp wait's per-wait fallback when no resident exists.
  "afk.landing.wait": "merge",
  // PR review gate (ADR 0064 §10, #749). When AFK opens a PR for a
  // completed attempt, the issue-classifier tier decides mechanical vs
  // non-mechanical: non-mechanical changes get `ready-for-review` (firing the
  // advisory review) and hold the merge; mechanical/trivial work keeps the
  // fast-merge path. Off by default so the autonomous loop's "merge fast / no
  // drift" behaviour is unchanged until a repo opts in. `threshold` is the
  // cheapest tier counted as non-mechanical (validate|simple|complex|think).
  "afk.review_gate.enabled": "false",
  "afk.review_gate.threshold": "complex",
  // Advisory adversarial review (ADR 0110, #2207). Default off: validated AFK
  // attempts land exactly as before. When enabled, AFK opens/resolves the PR,
  // runs one isolated reviewer pass over ONLY the Issue + diff, posts the full
  // findings to both the PR and Issue, then continues landing regardless of the
  // advisory verdict. Folded from `plugins.dev.review.*` to `dev.review.*`,
  // matching castle's fold and the `plugins.dev.* → dev.*` convention (#2244).
  "dev.review.enabled": "false",
  "dev.review.max_iterations": "1",
  "dev.review.reviewer_count": "1",
  "dev.review.quorum": "any",
  // Release channel the ADR 0038 launcher tracks (ADR 0058). `stable` is the
  // version-pinned release (today's behaviour); `canary` tracks npm's canary
  // dist-tag. The launcher reads this (or `RED_SKILLS_CHANNEL`); moving canary is
  // gated on the proof-by-drain telemetry.
  "afk.release.channel": "stable",
  // Per-attempt resource budgets (ADR 0128 §8). An attempt that reaches one of
  // these is terminated with an outcome NAMING the budget — never recorded as a
  // stall — and its branch/PR is handed forward, so the retry adopts the work
  // instead of restarting from main. `unlimited` (the default) means exactly
  // that: no ceiling. It is deliberately a word rather than `0`, which would
  // read as "terminate immediately". The wall-clock budget is NOT listed here:
  // it is the existing per-issue ceiling `afk.issue_wall_clock_max_s` (default
  // 2700), because two disagreeing wall-clock ceilings is the bug class ADR 0128
  // forbids.
  "afk.attempt.budget.peak_rss_mb": "unlimited",
  "afk.attempt.budget.cost_usd": "unlimited",
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
  // deps install every attempt). When true, attempts ACQUIRE a
  // warm, dependency-preserving worktree from a pool by LEASE and RETURN it on
  // completion (not destroy), so `node_modules` survives into the next lease —
  // removing the lost-deps false-`blocked:validation` footgun and the cold setup
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
  // Output shaping A/B measurement (#1638). OFF by default. When enabled, AFK
  // alternates by issue number: even issues receive a terse, phrasing-only
  // steering block; odd issues are the holdout. The assignment is stamped into
  // worker state beside the existing heartbeat output-token counters so the
  // report can compare steered vs unsteered output without changing semantics.
  "afk.output_shaping.terse_steering": "false",
  // Validation resource budget (#1758). Feedback/backpressure validation runs
  // after the inner agent has finished, often spawning vitest/tsc/build workers
  // outside the attempt guard. Keep Node heaps and Vitest worker fan-out bounded
  // by default so two AFK slots cannot OOM the host by validating heavy suites
  // at full parallelism. Repos may tune these under plugins.dev.afk.validation.
  "afk.validation.node_max_old_space_mb": "2048",
  "afk.validation.vitest_max_workers": "1",
  "afk.validation.heavy_available_memory_mb": "4096",
  // The `/afk` lane's GATE share of the Re-seed budget (ADR 0129, #2733), the
  // lane-scoped replacement for the retired `afk.stallConvergenceBudget`. It caps
  // only how many Re-seed rounds a red post-DONE gate may claim; the lane owns
  // the ceiling and the review's reserved round, so raising this can never eat
  // the round a blocking review finding is entitled to. Exhaustion parks
  // ready-for-human + blocked:validation with the last failing validation tail.
  // Override with RED_RESEED_GATE_BUDGET.
  "dev.reseed.afk.gate_budget": "3",
  // Spec cascade rebase (issue #1007). After a successful DONE landing, rebase
  // every open sibling branch (same spec:N, not held by a live worker) onto the
  // new base HEAD so the next worker to pick up a sibling starts from a
  // near-current base. Best-effort: a per-branch failure is logged as a warning
  // and never rolls back the primary landing. Set "false" to opt out.
  "afk.landing.cascade_rebase": "true",
  "dev.lock.primary-branch": "false",
  // What a superseded engine costs a dispatch (#3031). At dispatch time the
  // resolved engine's build-info is compared against the published dist-tag:
  // `warn` (default) dispatches loudly, naming both versions and the span of
  // fixes it forfeits; `refuse` makes it a hard stop; `off` silences the check.
  // The default is a warning because the class this closes is SILENCE — three
  // forensic recoveries on 2026-08-01 were all fix-merged-but-old-engine — while
  // refusing by default would ground every host that is merely one release
  // behind. An unreachable registry always degrades to a warning regardless of
  // policy: offline dispatch must not die. See core/engine-floor.ts.
  "dev.dispatch.engine_floor": "warn",
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

/**
 * The RETIRED config keys — an explicit tombstone set (ADR 0117, issue #2245).
 *
 * Unknown keys parse fine so a newer config can be read by an older binary, but
 * that forward-compat tolerance makes a key that USED to mean something
 * indistinguishable from one that does not mean anything YET: both are simply
 * carried in the map and never read. Every entry here is a key that WAS
 * documented and has since been removed. The loader DROPS it and warns
 * `retired`, so an operator whose `.red/config.yaml` still carries it learns the
 * setting stopped applying instead of believing it still tunes anything.
 *
 * Both spellings of a retired key are listed — the canonical namespaced one
 * (`plugins.dev.…`, ADR 0042) and the legacy top-level accessor — because either
 * can still be sitting in a repo's config.
 *
 * `afk.attempt_timeout` was the wall-clock attempt cap, retired when the
 * commit-anchored progress guard replaced it (ADR 0044/0045).
 *
 * `afk.stallConvergenceBudget` was the standalone post-DONE gate-correction
 * counter, retired when the four correction loops unified into one Re-seed with
 * a lane-scoped budget (ADR 0129). Its replacement is
 * `dev.reseed.afk.gate_budget`, which caps only the gate's SHARE of that budget.
 *
 * To retire a key: delete its reader, add BOTH spellings here, and record the
 * removal in the ADR that retires it.
 */
export const DELETED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "afk.attempt_timeout",
  "plugins.dev.afk.attempt_timeout",
  "afk.stallConvergenceBudget",
  "plugins.dev.afk.stallConvergenceBudget",
]);

/**
 * The ADR 0067 activation key. A directory opts into the dev plugin ONLY by
 * setting this to the scalar `true`; anything else — absent block, absent key,
 * `false` — leaves the plugin off. Mirrors `pluginEnabledInConfig` in
 * `packages/shared/plugin-gate.ts`; keep the two in lockstep.
 */
export const PLUGIN_ENABLED_KEY = "plugins.dev.enabled";

/**
 * Root keys the contract SANCTIONS. Every other root-level accessor spelling is
 * off-contract and warns (see {@link rootAccessorConfigCollisions}).
 *
 * `project.name` is the first entry and one of the few cases where the config
 * root is right rather than a leak: project identity is shared by the dev,
 * memory and brain plugins in one repository, so it belongs to none of them and
 * cannot live under `plugins.<name>.*`. The canonical reader is
 * `declaredProjectNameInConfig` in `packages/shared/project-identity.ts`, which
 * is deliberately gate-independent — a memory-only repository declares its
 * identity the same way a dev one does.
 *
 * To sanction a root key: add it here and record the sanction in the ADR that
 * grants it.
 */
export const SANCTIONED_ROOT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "project.name",
]);

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

function malformedConfigLine(line: number, reason: string): MalformedConfigError {
  return new MalformedConfigError(`malformed YAML at line ${line}: ${reason}`);
}

function indentOf(raw: string): number {
  return raw.match(/^\s*/)?.[0].length ?? 0;
}

function stripYamlComment(raw: string): string {
  const content = raw.trimStart();
  if (content === "" || content.startsWith("#")) return "";

  let quote: '"' | "'" | undefined;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function isLiteralBlockScalar(value: string): value is "|" | "|-" {
  return value === "|" || value === "|-";
}

function assertSupportedBlockScalar(line: number, value: string): void {
  if (value === ">" || value === ">-") {
    throw malformedConfigLine(line, "unsupported folded block scalar");
  }
  if (value.startsWith("|") && !isLiteralBlockScalar(value)) {
    throw malformedConfigLine(line, `unsupported literal block scalar indicator ${value}`);
  }
}

function readLiteralBlockScalar(
  lines: readonly string[],
  startIndex: number,
  headerIndent: number,
  indicator: "|" | "|-",
): { value: string; nextIndex: number } {
  const contentIndent = headerIndent + 2;
  const blockLines: string[] = [];
  let i = startIndex;

  for (; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, "");
    const isFinalSplitBlank = raw === "" && i === lines.length - 1;
    if (isFinalSplitBlank) break;

    const blank = raw.replace(/\s/g, "") === "";
    if (blank) {
      blockLines.push("");
      continue;
    }

    const indent = indentOf(raw);
    if (indent <= headerIndent) break;
    if (indent < contentIndent) {
      throw malformedConfigLine(i + 1, "literal block scalar continuation is under-indented");
    }
    blockLines.push(raw.slice(contentIndent));
  }

  const value = blockLines.join("\n");
  return {
    value: indicator === "|-" ? value : `${value}\n`,
    nextIndex: i,
  };
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

  const lines = text.split("\n");
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const lineNumber = lineIndex + 1;
    let raw = lines[lineIndex]!;
    lineIndex += 1;
    // strip a trailing CR (CRLF tolerance)
    raw = raw.replace(/\r$/, "");

    // Strip comments only when `#` is outside a quoted scalar. Full-line
    // comments are always skipped before the grammar sees them, even if their
    // example payload contains quotes.
    const stripped = stripYamlComment(raw);

    // skip blank / whitespace-only lines
    if (stripped.replace(/\s/g, "") === "") continue;

    const indentStr = stripped.match(/^\s*/)?.[0] ?? "";
    const indent = indentStr.length;
    if (indent % 2 !== 0) throw malformedConfigLine(lineNumber, "odd indentation");

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
      if (stack.length === 0) throw malformedConfigLine(lineNumber, "sequence item without a parent mapping");

      let item = rest.slice(1).replace(/^\s+/, "");
      if (item === "") throw malformedConfigLine(lineNumber, "empty sequence item");
      assertSupportedBlockScalar(lineNumber, item);
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
        if (!item.endsWith('"') || item.length < 2) {
          throw malformedConfigLine(lineNumber, "unclosed double-quoted sequence item");
        }
        item = item.slice(1, -1);
      } else if (item.startsWith("'")) {
        if (!item.endsWith("'") || item.length < 2) {
          throw malformedConfigLine(lineNumber, "unclosed single-quoted sequence item");
        }
        item = item.slice(1, -1);
      }

      const parent = stack.join(".");
      const idx = seqCounters[parent] ?? 0;
      seqCounters[parent] = idx + 1;
      if (isLiteralBlockScalar(item)) {
        const block = readLiteralBlockScalar(lines, lineIndex, indent, item);
        lineIndex = block.nextIndex;
        out[`${parent}.${idx}`] = block.value;
      } else {
        out[`${parent}.${idx}`] = item;
      }
      continue;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(rest)) {
      throw malformedConfigLine(lineNumber, "expected a mapping key");
    }

    const colon = rest.indexOf(":");
    const key = rest.slice(0, colon);
    let value = rest.slice(colon + 1).replace(/^\s+/, "");
    assertSupportedBlockScalar(lineNumber, value);

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
      if (!value.endsWith('"') || value.length < 2) {
        throw malformedConfigLine(lineNumber, "unclosed double-quoted scalar");
      }
      value = value.slice(1, -1);
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) {
        throw malformedConfigLine(lineNumber, "unclosed single-quoted scalar");
      }
      value = value.slice(1, -1);
    }

    // pop parents whose indent is >= current
    while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
      stack.pop();
      indents.pop();
    }

    const full = stack.length > 0 ? `${stack.join(".")}.${key}` : key;

    if (isLiteralBlockScalar(value)) {
      const block = readLiteralBlockScalar(lines, lineIndex, indent, value);
      lineIndex = block.nextIndex;
      out[full] = block.value;
    } else if (value === "") {
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
  /**
   * INSPECTION-ONLY bypass of the ADR 0067 activation gate (ADR 0116). Default
   * (absent/false) → the loader is fail-closed: a directory without
   * `plugins.dev.enabled: true` yields the defaults and none of its settings.
   *
   * Pass `true` ONLY to read a directory's configured values as DATA — a doctor
   * reporting what a not-yet-enabled repo has written, `/red-setup` inspecting a
   * config it is about to amend. Never pass it to decide behaviour, or the gate
   * is back to being advisory.
   */
  ignoreActivationGate?: boolean;
}

export interface RootDevConfigCollision {
  readonly key: string;
  readonly canonicalKey: string;
}

export interface RootAccessorConfigCollision {
  readonly key: string;
  readonly canonicalKey: string;
}

export interface ConfigParseFailure {
  readonly message: string;
  readonly line?: number;
  readonly construct?: string;
}

export interface ConfigLoadAudit {
  readonly path: string;
  readonly fileLoaded: boolean;
  readonly discarded: boolean;
  readonly values: ConfigValues;
  readonly parseFailure?: ConfigParseFailure;
  readonly rootAccessorCollisions: readonly RootAccessorConfigCollision[];
  /**
   * True when the file opted this directory into the dev plugin
   * (`plugins.dev.enabled: true`, ADR 0067). False for a missing file, a
   * malformed one, or one without the explicit opt-in.
   */
  readonly pluginEnabled: boolean;
  /**
   * True when the activation gate DISCARDED a well-formed file's settings
   * because the directory is not opted in (ADR 0116). `values` is the defaults.
   * Distinct from {@link discarded}, which means the YAML was malformed — a
   * gate-closed load is not a broken config.
   */
  readonly gateClosed: boolean;
  /**
   * The {@link DELETED_CONFIG_KEYS} the file still carries, sorted (ADR 0117).
   * Reported even when the gate closed, so a doctor can still name them.
   */
  readonly retiredKeys: readonly string[];
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

export function rootDevConfigCollisions(values: ConfigValues): RootDevConfigCollision[] {
  return Object.keys(values)
    .filter((key) => key.startsWith("dev."))
    .sort()
    .map((key) => ({
      key,
      canonicalKey: `plugins.${key}`,
    }));
}

export function rootDevConfigCollisionsFromText(text: string): RootDevConfigCollision[] {
  return rootDevConfigCollisions(parseConfigYaml(text));
}

function configParseFailure(err: unknown): ConfigParseFailure {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^malformed YAML at line (\d+): (.+)$/.exec(message);
  return match
    ? { message, line: Number(match[1]), construct: match[2] }
    : { message };
}

export function rootAccessorConfigCollisions(values: ConfigValues): RootAccessorConfigCollision[] {
  return Object.keys(values)
    .filter((key) => !SANCTIONED_ROOT_CONFIG_KEYS.has(key))
    .filter((key) => key.startsWith("dev.") || key.startsWith("afk."))
    .sort()
    .map((key) => ({
      key,
      canonicalKey: key.startsWith("afk.") ? `plugins.dev.${key}` : `plugins.${key}`,
    }));
}

export function auditConfigLoad(path: string, options: LoadConfigOptions = {}): ConfigLoadAudit {
  const read = options.read ?? defaultReader;
  const warn = options.warn ?? defaultWarn;

  const text = read(path);
  if (text === undefined) {
    return {
      path,
      fileLoaded: false,
      discarded: false,
      values: configDefaults(),
      rootAccessorCollisions: [],
      pluginEnabled: false,
      gateClosed: false,
      retiredKeys: [],
    };
  }

  let parsed: ConfigValues;
  try {
    parsed = parseConfigYaml(text);
  } catch (err) {
    const failure = configParseFailure(err);
    warn(`[afk:config] warn: malformed YAML in ${path} (${failure.message}) — using defaults`);
    return {
      path,
      fileLoaded: true,
      discarded: true,
      values: configDefaults(),
      parseFailure: failure,
      rootAccessorCollisions: [],
      pluginEnabled: false,
      gateClosed: false,
      retiredKeys: [],
    };
  }

  // Retired keys are named, not silently carried (ADR 0117). Reported and warned
  // BEFORE the activation gate so a disabled directory still learns its config
  // is stale, and dropped below so no accessor can ever read one back.
  const retiredKeys = Object.keys(parsed).filter((key) => DELETED_CONFIG_KEYS.has(key)).sort();
  for (const key of retiredKeys) {
    warn(
      `[afk:config] warn: \`${key}\` is a RETIRED key — it no longer does anything; ` +
        `remove it from ${path}`,
    );
  }

  const rootAccessorCollisions = rootAccessorConfigCollisions(parsed);
  const pluginEnabled = parsed[PLUGIN_ENABLED_KEY] === "true";

  // ACTIVATION GATE, decided in the loader (ADR 0116, harvested from the castle
  // twin). A directory that never opted into the dev plugin sees the defaults and
  // NOTHING of its own file — not the runner, not the model table, not the
  // backpressure commands. Deciding it here rather than only at process entry
  // means an in-process caller that skipped the entrypoint cannot read a disabled
  // directory's settings either. The diagnostics above are still reported: they
  // describe the file as data, they do not steer behaviour.
  if (!pluginEnabled && options.ignoreActivationGate !== true) {
    return {
      path,
      fileLoaded: true,
      discarded: false,
      values: configDefaults(),
      rootAccessorCollisions,
      pluginEnabled,
      gateClosed: true,
      retiredKeys,
    };
  }

  const values = configDefaults();
  const explicitAccessorKeys = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (DELETED_CONFIG_KEYS.has(key)) continue;
    values[key] = value;
    explicitAccessorKeys.add(key);
  }
  for (const collision of rootAccessorCollisions) {
    if (!collision.key.startsWith("dev.")) continue;
    warn(
      `[afk:config] warn: root-level \`${collision.key}\` is off-contract; ` +
        `use \`${collision.canonicalKey}\` in .red/config.yaml`,
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (DELETED_CONFIG_KEYS.has(key)) continue;
    const m = /^plugins\.dev\.(.+)$/.exec(key);
    if (!m) continue;
    const rest = m[1]!;
    const accessorKey = rest === "afk" || rest.startsWith("afk.") ? rest : `dev.${rest}`;
    values[accessorKey] = value;
    explicitAccessorKeys.add(accessorKey);
  }
  if (explicitAccessorKeys.size > 0) {
    values["\0explicit"] = Array.from(explicitAccessorKeys).join("\x01");
  }
  return {
    path,
    fileLoaded: true,
    discarded: false,
    values,
    rootAccessorCollisions,
    pluginEnabled,
    gateClosed: false,
    retiredKeys,
  };
}

/**
 * Load config from `path`, merging file overrides onto the v1 defaults.
 *
 * Mirrors `config_load`:
 *   - missing file → all defaults, no warning;
 *   - malformed YAML → exactly one warning mentioning the path, all defaults;
 *   - not opted in (`plugins.dev.enabled` is not `true`) → all defaults, the
 *     file's settings discarded (ADR 0116);
 *   - well-formed, opted-in file → defaults overlaid with every parsed key
 *     (including unknown ones, for forward compatibility) except the retired
 *     ones in {@link DELETED_CONFIG_KEYS} (ADR 0117).
 */
export function loadConfig(path: string, options: LoadConfigOptions = {}): ConfigValues {
  return auditConfigLoad(path, options).values;
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
 * The tier table's OWN default model/effort for a runner — the shipped pair,
 * with no file overrides, no legacy scalars, and no env applied. Every runner
 * ships a full table, so this pair is always runnable on that runner: it is the
 * last-resort substitute when an operator pins a model the runner's CLI cannot
 * dispatch (#2352). An unknown runner folds onto the claude table via
 * `toAgentRunner`, exactly as {@link resolveTier} does.
 */
export function defaultTier(runner: string, taskClass: AfkModelTier = "think"): ResolvedTier {
  const tierRunner = toAgentRunner(runner as Runner);
  const tier = (AFK_MODEL_TIERS as readonly string[]).includes(taskClass) ? taskClass : "think";
  return {
    model: CONFIG_DEFAULTS[defaultTierKey(tierRunner, tier, "model")!],
    effort: CONFIG_DEFAULTS[defaultTierKey(tierRunner, tier, "effort")!] as AgentEffort,
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
 * Read the TYPE labels this repo's installed vocabulary declares HUMAN-ONLY
 * (`afk.labels.hitl_types`, #2966). A Ticket carrying one resolves only through
 * a live exchange with a human, so an unblock sweep or close cascade routes it
 * to `ready-for-human` instead of the executable queue. The list form
 *
 *   afk:
 *     labels:
 *       hitl_types:
 *         - wayfinder:grilling
 *         - wayfinder:prototype
 *
 * materialises as the indexed keys `afk.labels.hitl_types.0`, … which this reads
 * back in order until the first gap; the namespaced `plugins.dev.*` location
 * folds down in {@link loadConfig} (ADR 0042). A single-line scalar is accepted
 * as a one-label list. Absent/empty → `[]`, and a repo that declares none keeps
 * the pre-#2966 behaviour exactly — every promotion goes to the agent lane.
 */
export function readHitlTypeLabels(values: Record<string, string | undefined>): string[] {
  const indexed: string[] = [];
  for (let i = 0; ; i++) {
    const v = values[`afk.labels.hitl_types.${i}`];
    if (v === undefined) break;
    if (v.trim() !== "") indexed.push(v.trim());
  }
  if (indexed.length > 0) return indexed;
  const scalar = values["afk.labels.hitl_types"];
  return scalar && scalar.trim() !== "" ? [scalar.trim()] : [];
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
export function readPostWorkerFormat(values: ConfigValues): string[] {
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

export interface ValidationResourceBudget {
  nodeMaxOldSpaceMb?: number;
  vitestMaxWorkers?: number;
  heavyAvailableMemoryMb?: number;
}

function readPositiveInt(values: ConfigValues, key: string): number | undefined {
  const raw = getConfig(values, key).trim();
  if (raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function readValidationResourceBudget(values: ConfigValues): ValidationResourceBudget {
  return {
    nodeMaxOldSpaceMb: readPositiveInt(values, "afk.validation.node_max_old_space_mb"),
    vitestMaxWorkers: readPositiveInt(values, "afk.validation.vitest_max_workers"),
    heavyAvailableMemoryMb: readPositiveInt(values, "afk.validation.heavy_available_memory_mb"),
  };
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

/** Default wait for a QUEUED merge to complete, in seconds (#2986) — 45 minutes.
 * The merge queue re-runs the whole required suite on its own merge group, and
 * queues behind other entries while doing it, so this is deliberately longer
 * than {@link DEFAULT_MERGE_CI_TIMEOUT_S}: a wait that expires early parks a
 * landing that was about to succeed. */
export const DEFAULT_MERGE_QUEUE_TIMEOUT_S = 2700;

/**
 * Resolve the queued-merge confirmation budget (#2986) from
 * `RED_AFK_MERGE_QUEUE_TIMEOUT_S`. A non-positive / unparseable value falls back
 * to {@link DEFAULT_MERGE_QUEUE_TIMEOUT_S}.
 */
export function resolveMergeQueueTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.RED_AFK_MERGE_QUEUE_TIMEOUT_S ?? "").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MERGE_QUEUE_TIMEOUT_S;
}
