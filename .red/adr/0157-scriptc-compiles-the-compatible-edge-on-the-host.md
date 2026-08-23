# 0157 — scriptc compiles the compatible edge, and the edge is compiled on the host

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0141 (statusline bedrock and the daemon-owned remote counters); ADR 0130 (the host-scoped daemon); ADR 0091 (canonical npx invocation)
- **Sources**: maintainer directive of 2026-08-23 ("definitivo para o que não seja unix socket — tudo o que for compatível é pra gente usar"); empirical probes compiled against scriptc 0.0.35 on the maintainer's host

## Context

The statusline is invoked on every prompt render. Splitting it into its own
lean bundle cut module evaluation from ~1.2s to ~0.19s, but a native binary
compiled with `scriptc` (vercel-labs' TypeScript-to-native compiler) answers
in ~2ms — measured, not estimated. The same probes established the boundary
the hard way: scriptc has **no lowering for Unix sockets** (not even under
`--dynamic`) and **none for `spawn` with piped stdio**, which are the two
pillars the daemon and the Worker stand on. And our distribution is ADR 0091's
`npx` form — platform-agnostic by design — while a native binary is one file
per platform.

## Decision

1. **scriptc is adopted for every compatible surface, and the boundary is
   stated once.** Compatible means: no Unix socket, no piped child stdio, and
   inside scriptc's static subset. Today that is the statusline's native
   front; the daemon, the Worker, and every socket-speaking surface are
   excluded by construction, not by preference. A surface that becomes
   compatible (scriptc grows a lowering, or the surface sheds its socket)
   adopts the same pattern in its own slice.

2. **The edge is compiled ON THE HOST, never shipped as a platform binary.**
   `redskilled unit install` best-effort-compiles the native front with
   `npx scriptc` when a C toolchain (`clang`) is present, writing
   `~/.red/redskilled/bin/statusline-fast`. No clang, no scriptc, no time —
   the install succeeds without it and says so. npm carries TypeScript and
   bundles only; ADR 0091's invocation stays canonical and platform-agnostic.

3. **The native front reads; the renderer writes.** The binary prints the
   last full render from the project's `.red/state/statusline/` lane in ~2ms
   and never speaks to the daemon; the lean node bundle runs in the
   background of every render and writes the next document. The tail is at
   most one render old — declared here as the accepted freshness contract for
   a statusline. The published statusline command prefers the native front
   when it exists and degrades to the synchronous lean bundle, then to the
   full bundle, then to the stated absence — each step observable, none
   configured.

## Consequences

- The native source lives in the daemon app and is embedded in its bundle as
  a constant (it is ~1.5KB), so the stabilized bundle can compile it without
  reaching back into a package tree that is not beside it.
- The command-doc guard grows the native-preference branch: preference order,
  glob non-capture, and a fixture host proving the native front wins when
  present and is invisible when absent.
- scriptc is pinned by version in the compile module; bumping it is an
  ordinary reviewed change, not an ambient `@latest`.
