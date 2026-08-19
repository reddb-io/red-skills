import type { AgentRunner } from "@reddb-io/worker/engine";

/**
 * Host-env allowlist for the no-sandbox agent process (issue #1368).
 *
 * Under the default `noSandbox` mode the inner agent used to inherit the
 * ENTIRE host `process.env` — including cloud credentials and arbitrary shell
 * exports the agent has no business seeing. red-castle's
 * `noSandbox({ hostEnvAllowlist })` now filters the base env; this module owns
 * WHAT the AFK runtime admits.
 *
 * Policy: default-deny with a generous toolchain allowlist. Everything an
 * agent legitimately needs — shell basics, ssh/git/gh auth, the agent CLIs'
 * own auth and state, our RED_* controls, and the language toolchains the
 * reddb ecosystem builds with — passes; unrelated host secrets (AWS_*,
 * GOOGLE_*, SLACK_*, DOCKER_*, random exports) do not.
 *
 * Entries are exact names or `*`-suffixed prefix globs (red-castle
 * `pickAllowedEnv` semantics). Go vars are enumerated individually because a
 * `GO*` glob would admit `GOOGLE_*`.
 */
export const AFK_HOST_ENV_ALLOWLIST: readonly string[] = [
  // shell / locale / terminal basics
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD",
  "TMPDIR", "TMP", "TEMP", "TERM", "COLORTERM",
  "LANG", "LANGUAGE", "LC_*", "TZ", "EDITOR", "PAGER", "CI",
  "XDG_*",
  // ssh + git + GitHub CLI (worker pushes over SSH; gh needs its token)
  "SSH_*", "GIT_*", "GH_*", "GITHUB_*",
  // agent CLIs: auth, state, harness signals
  "CLAUDE*", "ANTHROPIC*", "CODEX*", "OPENAI*", "OPENCODE*",
  "MINIMAX*", "OPENROUTER*",
  // our own controls (afk knobs, heartbeat, namespaces)
  "RED_*", "RTK_*",
  // JS/TS toolchain
  "NODE*", "NVM_*", "ASDF*", "NPM*", "PNPM*", "COREPACK*",
  "BUN*", "YARN*", "TURBO*", "VITEST*",
  // Rust
  "CARGO*", "RUSTUP*", "RUST*",
  // Go (enumerated — a GO* glob would admit GOOGLE_*)
  "GOPATH", "GOROOT", "GOBIN", "GOCACHE", "GOMODCACHE",
  "GOFLAGS", "GOPROXY", "GOPRIVATE", "GONOSUMDB", "GOTOOLCHAIN",
  // Python
  "PYTHON*", "PIP*", "UV_*", "VIRTUAL_ENV", "PYENV*",
  // JVM
  "JAVA*", "GRADLE*", "MAVEN*", "M2_*", "SDKMAN*", "KOTLIN*",
  // PHP / .NET / Dart / Zig
  "PHP*", "COMPOSER*", "DOTNET*", "NUGET*", "DART*", "PUB_*", "FLUTTER*", "ZIG*",
  // native build basics
  "CC", "CXX", "MAKEFLAGS", "PKG_CONFIG*", "LD_*",
];

/**
 * Entries always stripped from the codex allowlist, regardless of what the
 * base list or operator extensions admit. These are the known-poison variables
 * that Claude Code injects on the host and that must never reach a codex
 * worker's process environment (#2627):
 *
 * - `CLAUDE*` — Claude Code session state, snapshot pointers, entrypoint flags.
 * - `BASH_ENV` — sourced by every non-interactive bash shell; a Claude Code
 *   `BASH_ENV` value would inject Claude Code setup into the codex worker's
 *   child shells.
 * - `ENV` — the POSIX sh equivalent of `BASH_ENV`; same risk under sh.
 *
 * Operator passthrough via `RED_AFK_HOST_ENV_ALLOW` still re-admits these
 * for the rare case where an operator explicitly needs them.
 */
const CODEX_ENV_STRIP = new Set(["CLAUDE*", "BASH_ENV", "ENV"]);

/**
 * Resolve the effective allowlist. Codex strips `CLAUDE*`, `BASH_ENV`, and
 * `ENV` so Claude Code shell-snapshot pointers and shell-init file pointers
 * cannot leak into its child shells (#2627). `RED_AFK_HOST_ENV_ALLOW` extends
 * the runner default with comma-separated extra entries; the single literal `*`
 * is the escape hatch that disables minimization entirely (returns undefined →
 * red-castle inherits the full host env, the pre-#1368 behavior).
 */
export function resolveHostEnvAllowlist(
  env: NodeJS.ProcessEnv = process.env,
  runner?: AgentRunner,
): readonly string[] | undefined {
  const raw = env.RED_AFK_HOST_ENV_ALLOW ?? "";
  const extra = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes("*")) return undefined;
  const defaults =
    runner === "codex"
      ? AFK_HOST_ENV_ALLOWLIST.filter((entry) => !CODEX_ENV_STRIP.has(entry))
      : AFK_HOST_ENV_ALLOWLIST;
  return extra.length > 0 ? [...defaults, ...extra] : defaults;
}
