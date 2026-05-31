// The Runner-Spawn Module: ports the inner-agent invocation surface from
// `scripts/afk.sh` (special_user_request_block, run_claude, run_codex) plus the
// exhaustion grep. The argv builders mirror the exact spawn commands documented
// in runner-claude.md / runner-codex.md (inlined into run_claude / run_codex in
// afk.sh), so the actual spawn is testable by asserting argv.

// ---------- special user request block (special_user_request_block) ---------

/**
 * Build the `---- SPECIAL USER REQUEST ------` block, mirroring
 * `special_user_request_block`. Returns `null` when no request is set (the
 * bash `return 0` with empty output), matching the `[[ -n ... ]]` guard.
 */
export function specialUserRequestBlock(specialRequest: string | undefined): string | null {
  if (!specialRequest) return null;
  return ["---- SPECIAL USER REQUEST ------", specialRequest, "-------------------------------"].join("\n");
}

// ---------- per-runner argv builders (runner-claude.md / runner-codex.md) ---

/** Inputs shared by both runner argv builders. */
export interface SpawnArgsInput {
  /** The fully-assembled inner prompt. */
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

// Exhaustion strings — keep in sync with runner-*.md.
const exhaustionPattern =
  /usage limit|weekly (limit|cap)|session (limit|exhausted)|quota|rate_limit_error|try again later/i;

/** True when a stream line signals the runner hit a usage/quota limit. */
export function isRunnerExhausted(text: string): boolean {
  return exhaustionPattern.test(text);
}
