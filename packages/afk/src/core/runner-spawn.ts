import { detectSentinelLine, type AttemptOutcome } from "./attempt-reader.js";
import type { Runner } from "../types/runner.js";

// The Runner-Spawn Module: ports the inner-agent invocation surface from
// `scripts/afk.sh` (special_user_request_block, build_inner_prompt, run_inner,
// run_claude, run_codex) plus the *Stage Detection* table in SKILL.md.
//
// Everything here is PURE prompt-assembly / argv-building / stage detection
// with an injectable spawner. The real claude/codex process never runs in
// tests: `runInner` reads scripted stdout lines from the injected spawner and
// composes attempt-reader's sentinel detection. The argv builders mirror the
// exact spawn commands documented in runner-claude.md / runner-codex.md
// (inlined into run_claude / run_codex in afk.sh), so the actual spawn is
// testable by asserting argv.

// ---------- inner prompt assembly (build_inner_prompt) ----------------------

/** Inputs for {@link buildInnerPrompt}, mirroring run_inner's locals. */
export interface BuildInnerPromptInput {
  /** Body of AGENT-PROMPT.md (`prompt_body` in run_inner). */
  agentPromptBody: string;
  /** Path to the handoff file (`handoff` in run_inner). */
  handoffPath: string;
  /** `git log -n 5` block for main (`commits` in run_inner). */
  recentCommits: string;
  /** Optional `--request/-r` special user request ($SPECIAL_USER_REQUEST). */
  specialRequest?: string;
}

/**
 * Build the `---- SPECIAL USER REQUEST ------` block, mirroring
 * `special_user_request_block`. Returns `null` when no request is set (the
 * bash `return 0` with empty output), matching the `[[ -n ... ]]` guard.
 */
export function specialUserRequestBlock(specialRequest: string | undefined): string | null {
  if (!specialRequest) return null;
  return ["---- SPECIAL USER REQUEST ------", specialRequest, "-------------------------------"].join("\n");
}

/**
 * Assemble the full inner-agent prompt, byte-for-byte parity with
 * `build_inner_prompt`: handoff reference header, recent-commits block, the
 * optional special-request block, then the AGENT-PROMPT.md body.
 */
export function buildInnerPrompt(input: BuildInnerPromptInput): string {
  const requestBlock = specialUserRequestBlock(input.specialRequest);

  // printf 'Handoff file: %s  (read this first)\n\n'
  let out = `Handoff file: ${input.handoffPath}  (read this first)\n\n`;
  // printf 'Recent commits on main:\n%s\n'
  out += `Recent commits on main:\n${input.recentCommits}\n`;
  // if request_block: printf '\n%s\n'
  if (requestBlock !== null) {
    out += `\n${requestBlock}\n`;
  }
  // printf '\n%s\n'
  out += `\n${input.agentPromptBody}\n`;
  return out;
}

// ---------- stage detection (SKILL.md Stage Detection table) ----------------

/** Inner-agent stages detected from the runner's stdout stream. */
export const innerStages = ["setup", "explore", "impl", "tests", "commit"] as const;
export type InnerStage = (typeof innerStages)[number];

const stageOrder: Record<InnerStage, number> = {
  setup: 0,
  explore: 1,
  impl: 2,
  tests: 3,
  commit: 4,
};

// Stage signals, mirroring the SKILL.md *Stage Detection* table:
//   explore | `git ls-files`, `find`, repeated `Read`
//   impl    | first `Edit`/`Write` call
//   tests   | `pnpm test` invocation
//   commit  | `git commit` invocation
// Probed most-advanced-first so a single line carrying both an Edit and a
// later commit resolves to the furthest stage. Transitions are monotonic:
// the stage never moves backwards (matches the state-file write-forward model).
const stageSignals: ReadonlyArray<{ stage: InnerStage; pattern: RegExp }> = [
  { stage: "commit", pattern: /\bgit\s+commit\b/ },
  { stage: "tests", pattern: /\bpnpm\s+test\b/ },
  { stage: "impl", pattern: /\b(Edit|Write)\b/ },
  { stage: "explore", pattern: /\bgit\s+ls-files\b|\bfind\b|\bRead\b/ },
];

/**
 * Compute the next stage given a stdout line and the current stage, mirroring
 * the stdout-grep transitions described in SKILL.md. Never regresses: returns
 * whichever of `currentStage` / the line's signalled stage is further along.
 */
export function detectStage(streamLine: string, currentStage: InnerStage): InnerStage {
  let next = currentStage;
  for (const { stage, pattern } of stageSignals) {
    if (pattern.test(streamLine)) {
      if (stageOrder[stage] > stageOrder[next]) next = stage;
      break;
    }
  }
  return next;
}

// ---------- per-runner argv builders (runner-claude.md / runner-codex.md) ---

/** Inputs shared by both runner argv builders. */
export interface SpawnArgsInput {
  /** The fully-assembled inner prompt (output of {@link buildInnerPrompt}). */
  prompt: string;
  /** Absolute worktree path the inner agent runs in. */
  worktree: string;
}

/** A spawn invocation: the binary plus its argv (no shell). */
export interface SpawnInvocation {
  command: string;
  args: string[];
}

/**
 * Build the claude argv, mirroring run_claude in afk.sh:
 *   claude --model opus --effort medium --permission-mode bypassPermissions
 *          --output-format stream-json --verbose --print "$prompt"
 * Run from inside `$worktree` (bash `cd "$worktree"`), so the cwd is surfaced
 * via {@link SpawnInvocation} rather than a `-C` flag.
 */
export function claudeSpawnArgs(input: SpawnArgsInput): SpawnInvocation {
  return {
    command: "claude",
    args: [
      "--model",
      "opus",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      input.prompt,
    ],
  };
}

/**
 * Build the codex argv, mirroring run_codex in afk.sh:
 *   codex exec --json -C "$worktree" --sandbox danger-full-access
 *        --dangerously-bypass-approvals-and-sandbox
 *        --output-last-message "$last" "$prompt"
 * The `--output-last-message` sink path is passed in via `lastMessagePath`.
 */
export function codexSpawnArgs(input: SpawnArgsInput & { lastMessagePath: string }): SpawnInvocation {
  return {
    command: "codex",
    args: [
      "exec",
      "--json",
      "-C",
      input.worktree,
      "--sandbox",
      "danger-full-access",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message",
      input.lastMessagePath,
      input.prompt,
    ],
  };
}

// ---------- runner exhaustion (run_inner exhaustion grep) -------------------

// Exhaustion strings — keep in sync with run_inner's grep and runner-*.md.
const exhaustionPattern =
  /usage limit|weekly (limit|cap)|session (limit|exhausted)|quota|rate_limit_error|try again later/i;

/** True when a stream line signals the runner hit a usage/quota limit. */
export function isRunnerExhausted(text: string): boolean {
  return exhaustionPattern.test(text);
}

// ---------- runInner: injected spawner + stream reader ----------------------

/** A line-oriented stdout stream produced by the injected spawner. */
export interface SpawnedStream {
  /** Async iterable of decoded stdout lines (one assistant-text line each). */
  lines: AsyncIterable<string>;
}

/**
 * The injected spawner. In production this wraps node:child_process; in tests
 * it yields scripted stdout lines so no real claude/codex process is needed.
 */
export type InnerSpawner = (invocation: SpawnInvocation) => SpawnedStream | Promise<SpawnedStream>;

/** Resolved per-runner invocation for {@link runInner}. */
export interface RunInnerInput {
  runner: Runner;
  invocation: SpawnInvocation;
}

/** Outcome of an inner-agent attempt, composing stage + sentinel detection. */
export interface InnerResult {
  /** Final stage reached from the stdout stream. */
  stage: InnerStage;
  /** Sentinel outcome if one was authored on a line by itself, else null. */
  outcome: AttemptOutcome | null;
  /** True when an exhaustion string was seen (run_inner's RUNNER_EXHAUSTED). */
  exhausted: boolean;
  /** Last stdout line observed, mirroring the live-header `last:` field. */
  lastLine: string;
}

/**
 * Drive an inner-agent attempt with the injected `spawn`, composing
 * attempt-reader's sentinel detection with stage detection over the stdout
 * stream. Mirrors run_inner / run_claude / run_codex's stream-read loop: each
 * line advances the stage, the first authored sentinel sets the outcome, and
 * an exhaustion string flips the exhausted flag. The function returns once the
 * stream ends (EOF) — parity with attempt_reader_watch's bounded tear-down,
 * with the actual process lifecycle owned by the injected spawner.
 */
export async function runInner(spawn: InnerSpawner, input: RunInnerInput): Promise<InnerResult> {
  const stream = await spawn(input.invocation);

  let stage: InnerStage = "setup";
  let outcome: AttemptOutcome | null = null;
  let exhausted = false;
  let lastLine = "";

  for await (const line of stream.lines) {
    lastLine = line;
    stage = detectStage(line, stage);
    if (!exhausted && isRunnerExhausted(line)) exhausted = true;
    if (outcome === null) {
      const detected = detectSentinelLine(line);
      if (detected) outcome = detected;
    }
  }

  return { stage, outcome, exhausted, lastLine };
}
