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
 * Resolve the effective allowlist. `RED_AFK_HOST_ENV_ALLOW` extends the
 * default with comma-separated extra entries; the single literal `*` is the
 * escape hatch that disables minimization entirely (returns undefined →
 * red-castle inherits the full host env, the pre-#1368 behavior).
 */
export function resolveHostEnvAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] | undefined {
  const raw = env.RED_AFK_HOST_ENV_ALLOW ?? "";
  const extra = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes("*")) return undefined;
  return extra.length > 0 ? [...AFK_HOST_ENV_ALLOWLIST, ...extra] : AFK_HOST_ENV_ALLOWLIST;
}
