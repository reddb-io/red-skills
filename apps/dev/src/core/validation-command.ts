// validation-command.ts — the gate's command-composition layer (#3041).
//
// Every `pnpm -C <dir> <script>` the post-DONE gate runs — and, more sharply,
// every one it RECORDS — is composed here. A recorded command carrying a
// RELATIVE `-C` path is unfalsifiable: it resolves against whatever the process
// cwd happened to be, so a gate that never executed a byte reads exactly like a
// branch whose typecheck failed. Worker wO0AR (#3027) recorded
// `pnpm -C afk/3027-…/apps/dev typecheck` exiting 1 after 0 ms, burned its
// re-seed budget against that phantom, and parked a branch whose own PR CI was
// fully green; the only tell was the millisecond count.
//
// Three rules, one per way that verdict lied:
//
//   1. **A checkout token resolves to an ABSOLUTE path before composition.**
//      The record then names a directory a reader can `ls`, and a token that
//      resolved nowhere is visible as such instead of reading as a package dir.
//   2. **A DECLARED checkout whose directory is missing is an infrastructure
//      error, never a red validation verdict.** An unrunnable command judged
//      nothing, so it may not consume a re-seed round or park a branch — the
//      same honesty rule the admission verdicts follow: a refusal carries what
//      it judged.
//   3. **A suite-shaped command that exits in under a second did not run a
//      suite.** The record carries `suspectInfra` and says why, rather than
//      leaving the operator to spot the duration.
//
// A branch TOKEN is left verbatim on purpose. The AFK gate is posed with the
// worker branch name (`afk/<n>-<slug>`), which the feedback-worktree executor
// materialises and rewrites onto a real checkout at exec time; absolutising it
// here would turn a branch name into a path nothing can check out. What the
// executor resolves it to comes back as `ExecResult.commandDir` and is what
// lands in the record, so the branch lane gets an absolute path too — measured
// rather than composed.

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Frozen wire vocabulary: the Verdict matches these as environment causes, so
 * a summary appends to them rather than weaving them in.
 */
export const VALIDATION_TARGET_MISSING_MARKER = "validation worktree directory is missing";
/** @see VALIDATION_TARGET_MISSING_MARKER */
export const SUSPECT_INFRA_MARKER = "suspect-infra";

/**
 * How fast a suite-shaped command has to exit before its verdict is suspect.
 * `pnpm`'s own startup — resolving the workspace, spawning the script — costs
 * more than this on every host we run on, so a sub-second exit means the suite
 * never started. Deliberately coarse: the claim is "this did not run", not a
 * performance budget.
 */
export const SUITE_MIN_PLAUSIBLE_MS = 1000;

/**
 * What the `worktree` token IS.
 *
 * - `checkout` — a directory on disk. Resolved to an absolute path; a missing
 *   one is an infrastructure refusal.
 * - `branch` — a branch name the executor materialises later. Left verbatim.
 */
export type ValidationTargetKind = "checkout" | "branch";

export interface ValidationTarget {
  kind: ValidationTargetKind;
  /**
   * What commands compose against: the ABSOLUTE checkout directory for a
   * `checkout` target, the branch token verbatim for a `branch` one.
   */
  root: string;
  /** The token exactly as the caller stated it. */
  token: string;
  /**
   * True only for a `checkout` the caller DECLARED whose directory could not be
   * found. An auto-detected token is never `missing` — absent a declaration
   * there is no proof a token that is not a directory was meant to be one.
   */
  missing: boolean;
  /** Every absolute path probed while resolving the token, for the diagnostic. */
  probed: readonly string[];
}

export interface ResolveValidationTargetOptions {
  /** The checkout a relative token is anchored to — never the process cwd. */
  root: string;
  /**
   * Directory probe, and the gate's only source of PROOF. Injected so the
   * composition layer stays pure; production passes {@link realDirectoryProbe}.
   * Omitted → the target is resolved but never probed, and so is never
   * `missing`: a gate that cannot look at the disk has no grounds to refuse.
   */
  isDirectory?: (dir: string) => boolean;
  /**
   * What the caller KNOWS the token to be. Omitted → auto-detect, which can
   * only ever downgrade to `branch`: a caller that has not declared a checkout
   * has not given the gate grounds to refuse.
   */
  kind?: ValidationTargetKind;
}

/** `statSync`-backed directory probe. Any error reads as "not a directory". */
export function realDirectoryProbe(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a `worktree` token to the thing commands compose against.
 *
 * A relative checkout token is anchored to `root` first and to the process cwd
 * only as a fallback — the cwd is exactly the ambient state that made the
 * #3027 record unreadable, so it is the last resort rather than the default.
 */
export function resolveValidationTarget(
  token: string,
  opts: ResolveValidationTargetOptions,
): ValidationTarget {
  const anchor = resolve(opts.root);
  const isDirectory = opts.isDirectory;

  if (opts.kind === "branch") {
    return { kind: "branch", root: token, token, missing: false, probed: [] };
  }

  const probed = token === ""
    ? [anchor]
    : isAbsolute(token)
      ? [resolve(token)]
      : [resolve(anchor, token), resolve(token)];

  // No probe, no proof. A DECLARED checkout still resolves to an ABSOLUTE path
  // — that alone fixes the unreadable record — but it is never called missing,
  // and an undeclared token stays the branch name the executor materialises.
  if (isDirectory === undefined) {
    if (opts.kind === "checkout") {
      return { kind: "checkout", root: probed[0] ?? anchor, token, missing: false, probed };
    }
    return { kind: "branch", root: token, token, missing: false, probed: [] };
  }

  for (const candidate of probed) {
    if (isDirectory(candidate)) {
      return { kind: "checkout", root: candidate, token, missing: false, probed };
    }
  }

  // Nothing on disk. Only a DECLARED checkout is refused; an undeclared token
  // is a branch name the executor will materialise (the AFK gate's normal
  // shape), and calling that a missing directory would refuse every worker run.
  if (opts.kind === "checkout") {
    return { kind: "checkout", root: probed[0] ?? anchor, token, missing: true, probed };
  }
  return { kind: "branch", root: token, token, missing: false, probed };
}

/** The one-line cause a missing-target refusal records. */
export function targetMissingSummary(target: ValidationTarget): string {
  const tried = target.probed.map((p) => `\`${p}\``).join(", ") || "no candidate";
  return (
    `${VALIDATION_TARGET_MISSING_MARKER}: \`${target.token}\` resolved to ${tried}, ` +
    `none of which is a directory — the gate ran nothing, so this is an infrastructure ` +
    `error and not the branch's validation verdict`
  );
}

export interface ComposedValidationCommand {
  /** The `-C` argument. Absolute whenever the target is a checkout. */
  dir: string;
  /** Full argv, `pnpm` head included, ready for the injected executor. */
  args: string[];
  /** The display string a `red.afk.validation.v1` record carries. */
  command: string;
}

/**
 * Compose one validation command for `scope` under `target`.
 *
 * The scope join is deliberately different per kind: a checkout is resolved
 * (absolute, normalised), a branch token is concatenated so the executor's
 * `splitBranchDir` can still peel the package suffix back off.
 */
export function composeValidationCommand(input: {
  target: ValidationTarget;
  /** Package scope, `"."` for the target root. */
  scope: string;
  /** The package script to run. */
  script: string;
  /** Extra args appended after `--` (the quarantine `--exclude` list). */
  extraArgs?: readonly string[];
}): ComposedValidationCommand {
  const { target, scope, script } = input;
  const extraArgs = input.extraArgs ?? [];
  const dir =
    scope === "." || scope === ""
      ? target.root
      : target.kind === "checkout"
        ? resolve(target.root, scope)
        : `${target.root}/${scope}`;
  const args = ["pnpm", "-C", dir, script, ...(extraArgs.length > 0 ? ["--", ...extraArgs] : [])];
  return { dir, args, command: renderValidationCommand(dir, script, extraArgs) };
}

/** `pnpm -C <dir> <script>[ -- <extra…>]` — the record's display string. */
export function renderValidationCommand(
  dir: string,
  script: string,
  extraArgs: readonly string[] = [],
): string {
  const tail = extraArgs.length > 0 ? ` -- ${extraArgs.join(" ")}` : "";
  return `pnpm -C ${dir} ${script}${tail}`;
}

/**
 * The command to RECORD, given where the executor actually ran it.
 *
 * `commandDir` is the executor's own answer: the feedback-worktree executor
 * rewrites a branch token onto the materialised checkout, so the record can
 * name the absolute directory the suite really ran in rather than the branch
 * token that was posed to it. Absent (no rewrite, or setup failed before the
 * command existed) → the composed command stands.
 */
export function recordedValidationCommand(
  composed: ComposedValidationCommand,
  script: string,
  extraArgs: readonly string[] = [],
  commandDir?: string,
): string {
  if (commandDir === undefined || commandDir === "") return composed.command;
  return renderValidationCommand(commandDir, script, extraArgs);
}

/**
 * Did this failure exit too fast to have run anything?
 *
 * Only failures are judged — a suite that PASSES in 3 ms is a caching win, not
 * a lie — and only measured durations: an unmeasured check makes no claim.
 */
export function isSuspectInfraFailure(input: {
  status: string;
  durationMs?: number;
}): boolean {
  if (input.status !== "failed") return false;
  const { durationMs } = input;
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return false;
  return durationMs < SUITE_MIN_PLAUSIBLE_MS;
}

/** Prefix a summary with the suspect-infra claim and the evidence for it. */
export function suspectInfraSummary(input: {
  command: string;
  exitCode: number;
  durationMs: number;
  summary: string;
}): string {
  const head =
    `${SUSPECT_INFRA_MARKER}: \`${input.command}\` exited ${input.exitCode} after ` +
    `${input.durationMs}ms — under ${SUITE_MIN_PLAUSIBLE_MS}ms is too fast for a suite ` +
    `command to have started, so read this as an environment failure before the branch's`;
  return input.summary === "" ? head : `${head}. ${input.summary}`;
}
