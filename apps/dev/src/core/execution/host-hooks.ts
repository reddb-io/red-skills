import type { RunOptions } from "@reddb-io/worker";

/** The sandcastle `host.onWorktreeReady` hook command shape. */
export type HostHookCommand = NonNullable<NonNullable<NonNullable<RunOptions["hooks"]>["host"]>["onWorktreeReady"]>[number];

/**
 * Build the single `host.onWorktreeReady` hook command that restores the AFK
 * continuous-push guarantee (issue #191) for a host-visible worktree.
 *
 * sandcastle runs `host.onWorktreeReady` ON THE HOST with cwd = the worktree it
 * just created (noSandbox worktree mode and bind-mount worktree mode), so this
 * command, in that worktree:
 *   (a) force-with-lease pushes the worker branch to the remote up-front
 *       (`push_initial`), and
 *   (b) installs a `post-commit` git hook that fire-and-forgets a push after
 *       every inner-agent commit (`install_post_commit_hook`), into an AFK-owned
 *       hooks dir the worktree's `core.hooksPath` is then pointed at — which also
 *       bypasses the consumer repo's commit-phase hooks for AFK's commits (#840).
 *
 * Every step is best-effort: a network / auth failure logs to stderr (via the
 * shell `||` fallbacks) but never returns non-zero, so the hook can NOT abort
 * the run. The post-commit hook itself ends in `|| true` for the same reason
 * (git ignores a post-commit exit status, but we belt-and-braces it).
 *
 * The hook is written with `git rev-parse --absolute-git-dir` so it lands in the
 * linked worktree's own gitdir (`afk-hooks/`) and the `core.hooksPath` redirect is
 * set `--worktree`, never leaking into the primary checkout or a sibling
 * worktree — the primary branch's hooks stay exactly as the consumer wrote them.
 */
export function buildContinuousPushHook(branch: string, remote: string): HostHookCommand {
  // Single-quoted heredoc body so the inner `$()` / `HEAD` are evaluated when
  // the post-commit hook RUNS, not when it is written. The outer `sh -c` script
  // is itself single-quoted at the call site, so embedded single quotes in the
  // heredoc are avoided; we use printf with the literal hook text instead.
  const initialPush = `git push ${remote} -u "HEAD:refs/heads/${branch}" --force-with-lease >/dev/null 2>&1 || echo "[afk] warn: initial push for ${branch} failed, continuing without remote backup" >&2`;
  // The post-commit hook content (issue #191). Written via printf so we never
  // depend on a heredoc surviving the sh -c quoting. The trailing `|| true`
  // keeps the hook a pure side-effect.
  const hookBody = [
    "#!/usr/bin/env sh",
    "# AFK continuous-push hook (issue #191)",
    "# Fire-and-forget: push the worker branch to the remote after every commit so",
    "# a SIGKILL of the orchestrator at any point preserves the diff on the remote.",
    `git push ${remote} HEAD --force-with-lease 2>/dev/null || true`,
    "",
  ].join("\n");
  // Install the post-commit hook into an AFK-OWNED hooks dir (`afk-hooks`) inside
  // the worktree's gitdir, then point the worktree's `core.hooksPath` at it (issue
  // #840). This single redirect does three things at once:
  //   (a) BYPASSES the consumer repo's commit-phase hooks (pre-commit / commit-msg
  //       / pre-push) for every AFK commit — those live in the COMMON gitdir's
  //       `hooks/`, which `core.hooksPath` now shadows; redundant with AFK's own
  //       feedback gate + backpressure + `.red/config.yaml` lifecycle hooks, and a
  //       reformat-and-restage hook would otherwise break the one-path-staged
  //       invariant (false BLOCKED).
  //   (b) KEEPS AFK's own post-commit push firing — it is the only hook in
  //       `afk-hooks`. (A linked worktree never fires hooks from its private gitdir
  //       `hooks/` — only the common dir or `core.hooksPath` — so the redirect is
  //       also what makes the issue #191 push hook actually run here.)
  //   (c) STAYS worktree-scoped via `git config --worktree`, so the primary
  //       checkout's hooks are untouched (the primary branch is sacred). We never
  //       fall back to a non-worktree `core.hooksPath`, which would leak into the
  //       common config and silence the consumer's hooks in the primary checkout.
  // The bypass is commit-phase only: this runs in `onWorktreeReady`, after
  // the worktree exists and before the inner agent starts.
  const installHook = [
    'gd=$(git rev-parse --absolute-git-dir 2>/dev/null) || gd=""',
    'if [ -n "$gd" ]; then',
    '  hd="$gd/afk-hooks"',
    '  mkdir -p "$hd" 2>/dev/null || true',
    `  printf '%s' "$HOOK_BODY" > "$hd/post-commit" 2>/dev/null && chmod 0755 "$hd/post-commit" 2>/dev/null || echo "[afk] warn: could not install post-commit hook" >&2`,
    '  git config extensions.worktreeConfig true 2>/dev/null || true',
    '  git config --worktree core.hooksPath "$hd" 2>/dev/null || echo "[afk] warn: could not redirect core.hooksPath — consumer git hooks may fire on AFK commits" >&2',
    "else",
    '  echo "[afk] warn: could not resolve .git dir — post-commit hook not installed" >&2',
    "fi",
  ].join("\n");
  // HOOK_BODY is exported inline so the heredoc-free printf above reads it. The
  // whole script is wrapped in `sh -c` and always exits 0 (best-effort).
  const script = [`HOOK_BODY=${shSingleQuote(hookBody)}`, "export HOOK_BODY", initialPush, installHook, "exit 0"].join(
    "\n",
  );
  return { command: `sh -c ${shSingleQuote(script)}` };
}

/**
 * Install the AFK-owned `commit-msg` hook that fail-closes public-output leaks
 * before an inner agent can put them in git history (#1366).
 *
 * AFK redirects `core.hooksPath` to the worktree-private `afk-hooks` directory
 * for the same reason as continuous push: consumer hooks are bypassed, but AFK
 * still owns the hooks it needs in its isolated worktree.
 */
export function buildNoLeakCommitMsgHook(): HostHookCommand {
  const hookBody = [
    "#!/usr/bin/env sh",
    "# AFK no-leak commit-msg hook (issue #1366)",
    "msg=${1:-}",
    'if [ -n "$msg" ] && grep -F "claude.ai/code/session_" "$msg" >/dev/null 2>&1; then',
    '  echo "[afk] blocked commit message: redact Claude session links as [REDACTED_CLAUDE_SESSION]" >&2',
    "  exit 1",
    "fi",
    'if [ -n "$msg" ]; then',
    "  env | while IFS='=' read -r name value; do",
    '    [ -n "$value" ] || continue',
    "    [ ${#value} -ge 8 ] || continue",
    '    upper=$(printf "%s" "$name" | tr "[:lower:]" "[:upper:]")',
    '    case "$upper" in',
    "      *TOKEN*|*SECRET*|*PASSWORD*|*APIKEY*|*API_KEY*|*API-KEY*) ;;",
    "      *) continue ;;",
    "    esac",
    '    if grep -F -- "$value" "$msg" >/dev/null 2>&1; then',
    "      exit 42",
    "    fi",
    "  done",
    "  rc=$?",
    '  if [ "$rc" -eq 42 ]; then',
    '    echo "[afk] blocked commit message: redact sensitive environment variable value as [REDACTED_SECRET]" >&2',
    "    exit 1",
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const installHook = [
    'gd=$(git rev-parse --absolute-git-dir 2>/dev/null) || gd=""',
    'if [ -n "$gd" ]; then',
    '  hd="$gd/afk-hooks"',
    '  mkdir -p "$hd" 2>/dev/null || true',
    `  printf '%s' "$HOOK_BODY" > "$hd/commit-msg" 2>/dev/null && chmod 0755 "$hd/commit-msg" 2>/dev/null || echo "[afk] warn: could not install commit-msg no-leak hook" >&2`,
    '  git config extensions.worktreeConfig true 2>/dev/null || true',
    '  git config --worktree core.hooksPath "$hd" 2>/dev/null || echo "[afk] warn: could not redirect core.hooksPath — AFK commit-msg guard may not fire" >&2',
    "else",
    '  echo "[afk] warn: could not resolve .git dir — commit-msg no-leak hook not installed" >&2',
    "fi",
  ].join("\n");
  const script = [`HOOK_BODY=${shSingleQuote(hookBody)}`, "export HOOK_BODY", installHook, "exit 0"].join("\n");
  return { command: `sh -c ${shSingleQuote(script)}` };
}

/**
 * Record the real worktree path so the heartbeat's loc diff targets it directly.
 *
 * `onWorktreeReady` runs ON THE HOST with cwd = the worktree the castle just
 * created (`{workerWorkspace}/worktree`), so its `pwd` is the ground-truth
 * absolute worktree path. We write it into the parent worker workspace as
 * `.worktree-path`.
 *
 * The heartbeat reads that file instead of RECONSTRUCTING the worktree from
 * `attemptDir` — reconstruction (`git worktree list` on the primary + a
 * filesystem probe) proved unreliable for mirror-owned worktrees; having castle
 * publish its own path remains the single source of truth. Best-effort: a write
 * failure leaves the heartbeat on its conventional-path fallback.
 */
export function buildWorktreePathCaptureHook(): HostHookCommand {
  return { command: `sh -c 'pwd > ../.worktree-path 2>/dev/null || true'` };
}

/** POSIX single-quote escaping: wrap in single quotes, replacing each embedded
 * single quote with the `'\''` idiom. Keeps the embedded git push / hook body
 * intact through the `sh -c '<script>'` layer. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
