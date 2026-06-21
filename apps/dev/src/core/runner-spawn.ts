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
  /** Optional provider model id resolved from the AFK tier table. */
  model?: string;
  /** Optional provider reasoning effort resolved from the AFK tier table. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
 *   codex exec --model "$model" -c model_reasoning_effort="$effort"
 *        --json -C "$worktree" --sandbox danger-full-access
 *        --dangerously-bypass-approvals-and-sandbox
 *        --output-last-message "$last" "$prompt"
 * The `--output-last-message` sink path is passed in via `lastMessagePath`.
 */
export function codexSpawnArgs(input: SpawnArgsInput & { lastMessagePath: string }): SpawnInvocation {
  const tierArgs = [
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["-c", `model_reasoning_effort=${input.effort}`] : []),
  ];
  return {
    command: "codex",
    args: [
      "exec",
      ...tierArgs,
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
// MiniMax Anthropic-compatible endpoint surfaces quota depletion as "balance"
// terms (e.g. "Insufficient balance", "balance insufficient") and HTTP 429 /
// "insufficient credits" variants alongside the standard Anthropic
// rate_limit_error (#793).
const exhaustionPattern =
  /usage limit|weekly (limit|cap)|session (limit|exhausted)|quota|rate_limit_error|try again later|\bbalance\b|\b429\b|insufficient.credit/i;

/** True when a stream line signals the runner hit a usage/quota limit. */
export function isRunnerExhausted(text: string): boolean {
  return exhaustionPattern.test(text);
}
