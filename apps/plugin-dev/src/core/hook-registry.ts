import { CANONICAL_HOOK_NAMES, type HookName } from "./hook-config.js";

/**
 * hook-registry.ts — the canonical hook registry (#834, PRD #829).
 *
 * `hook-config.ts` owns the *names* and the resolution order; this module owns
 * the per-point **contract metadata**: the stdin-JSON context schema (which
 * fields a hook receives) and the mutable-slice descriptor (which of those a
 * hook may rewrite via stdout JSON), plus the exit-code policy class.
 *
 * One registry, two derived consumers (issue #834):
 *   - the generated CONFIG.md context-schema reference (a drift test guards it,
 *     so the doc can never disagree with the wired contract);
 *   - `/dev:doctor`'s static validation (it reads the same name set to pre-catch
 *     unknown hook names read-only).
 *
 * The registry is intentionally pure data + a renderer — no IO — so the drift
 * test can re-render and compare byte-for-byte.
 */

/**
 * Exit-code policy class for a lifecycle point (CONFIG.md "Exit-code policy"):
 *   - `abort` — a non-zero exit stops the step (every `pre_*` point);
 *   - `continue` — a non-zero exit is logged and the loop proceeds, so a broken
 *     notifier can never wedge AFK (every `post_*` / `on_*` point).
 */
export type ExitPolicy = "abort" | "continue";

/** One field of a hook's stdin-JSON context. */
export interface HookContextField {
  /** The JSON key as it appears on stdin (e.g. `issue`, `scopes[]`). */
  readonly name: string;
  /**
   * Whether the field is part of the point's **mutable slice** — a hook may
   * return `{<name>: …}` on stdout to replace it. `false` means read-only
   * context (returning it is ignored).
   */
  readonly mutable: boolean;
}

/** The contract metadata for a single lifecycle point. */
export interface HookSpec {
  /** The stdin-JSON context schema, in documentation order. */
  readonly context: readonly HookContextField[];
  /** How a non-zero exit is routed. */
  readonly exit: ExitPolicy;
}

const ro = (name: string): HookContextField => ({ name, mutable: false });
const mut = (name: string): HookContextField => ({ name, mutable: true });

/**
 * The canonical contract for every lifecycle point in `CANONICAL_HOOK_NAMES`.
 * The field set and mutability mirror CONFIG.md's "Lifecycle Hooks" table; this
 * object is the single source the doc table is generated from.
 */
export const HOOK_REGISTRY: Record<HookName, HookSpec> = {
  pre_session: {
    context: [mut("runner"), mut("worker_id"), mut("filter"), mut("iter_cap")],
    exit: "abort",
  },
  pre_pick: {
    context: [mut("label"), mut("state"), mut("limit"), ro("filter")],
    exit: "abort",
  },
  post_pick: {
    context: [mut("issues[]")],
    exit: "continue",
  },
  pre_worktree: {
    context: [mut("issue"), mut("target"), mut("env"), ro("branch")],
    exit: "abort",
  },
  pre_attempt: {
    context: [mut("issue"), mut("workspace"), mut("attempt_n"), ro("runner")],
    exit: "abort",
  },
  post_attempt: {
    context: [mut("issue"), mut("workspace"), mut("result"), mut("attempt_n")],
    exit: "continue",
  },
  pre_feedback: {
    context: [mut("issue"), mut("workspace"), mut("scopes[]")],
    exit: "abort",
  },
  on_baseline_probe: {
    context: [ro("issue"), ro("workspace"), ro("ok"), ro("inconclusive[]")],
    exit: "continue",
  },
  post_feedback: {
    context: [mut("issue"), mut("workspace"), mut("result")],
    exit: "continue",
  },
  pre_merge: {
    context: [mut("issue"), mut("workspace"), mut("diff"), ro("branch")],
    exit: "abort",
  },
  post_merge: {
    context: [mut("issue"), mut("workspace"), mut("merge_commit")],
    exit: "continue",
  },
  on_attempt_error: {
    context: [mut("issue"), mut("workspace"), mut("error"), mut("attempt_n")],
    exit: "continue",
  },
  on_recovery_decision: {
    context: [ro("issue"), mut("decision"), ro("reason"), ro("attempt_n")],
    exit: "continue",
  },
  on_blocked: {
    context: [ro("issue"), ro("blocked_label"), ro("reason"), ro("attempt_n")],
    exit: "continue",
  },
  on_reconcile: {
    context: [ro("issue"), ro("workspace"), ro("attempt_n"), ro("outcome")],
    exit: "continue",
  },
  on_idle: {
    context: [ro("stats")],
    exit: "continue",
  },
  on_heartbeat: {
    context: [ro("issue"), ro("workspace"), ro("runner"), ro("attempt_n"), ro("vitals")],
    exit: "continue",
  },
  post_session: {
    context: [mut("runner"), mut("worker_id"), mut("stats")],
    exit: "continue",
  },
  on_session_error: {
    context: [ro("error")],
    exit: "continue",
  },
};

/** Render a comma-joined field list, or an em dash when empty. */
function fieldList(fields: readonly HookContextField[]): string {
  if (fields.length === 0) return "—";
  return fields.map((f) => `\`${f.name}\``).join(", ");
}

/**
 * Render the per-point context-schema table generated into CONFIG.md. The drift
 * test re-renders this and asserts CONFIG.md carries it verbatim, so the doc can
 * never disagree with the registry.
 *
 * Columns: the hook name, its stdin-JSON context fields, the mutable subset
 * (what a hook may rewrite via stdout JSON), and the exit-code policy class.
 * Iteration follows `CANONICAL_HOOK_NAMES` so the doc order tracks execution
 * order.
 */
export function renderHookContextTable(): string {
  const header =
    "| Hook | Stdin context (JSON) | Mutable slice | Exit policy |\n" +
    "|---|---|---|---|";
  const rows = CANONICAL_HOOK_NAMES.map((name) => {
    const spec = HOOK_REGISTRY[name];
    const mutable = spec.context.filter((f) => f.mutable);
    const mutableCol = mutable.length === 0 ? "_none (read-only)_" : fieldList(mutable);
    const exitCol = spec.exit === "abort" ? "non-zero **aborts**" : "non-zero **logged**, continues";
    return `| \`${name}\` | ${fieldList(spec.context)} | ${mutableCol} | ${exitCol} |`;
  });
  return [header, ...rows].join("\n");
}
