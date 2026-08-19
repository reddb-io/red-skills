# @reddb-io/protocol-acp

The shared RedSkills ACP wire, in one package. ADR 0148 (the shared wire moves
out of the daemon), ADR 0145 §2–3 and §7 (v1/v2 compat, the wire major, the
local transport), ADR 0153 (the name).

## Why it exists

ACP is the sole agent protocol through the RedSkills control and execution chain
(ADR 0145). That chain has at least three bodies — the `redskilled` daemon, the
Worker, and the stateless MCP/CLI adapters — and every one of them sits on the
same socket speaking the same four things:

1. **Which ACP contract is in force.** ACP v2 draft revisions share
   `protocolVersion: 2` while changing incompatibly, so the number on the wire
   does not identify the contract; the revision names itself in
   `_meta.redskills`.
2. **Which RedSkills wire major is in force.** An independent axis: two peers
   can agree on ACP and still be forbidden to exchange workflow traffic.
3. **How the local endpoint is bound.** One control endpoint per authority —
   Unix socket on Linux, Named Pipe on Windows — differing in exactly one
   observable way, that a Unix socket leaves a filesystem node the next bind
   must remove.
4. **What the `_redskills/*` methods are called.**

Each of those is an *agreement between two processes*, which makes a private
copy the worst possible place to keep it: a second spelling does not fail to
compile, it fails at run time, on the far side of a socket, on the platform the
author does not use. This package is the single spelling.

## What is NOT here

The body-versus-control cut of ADR 0148 holds. This package moves bytes and
names methods; it decides nothing. Admission, budget policy, the GitHub
gateway, Project control state, session journalling, placement — all stay with
the authority that owns them. A validator lives here only when its rule is pure
protocol (`emptyRedskillsParams`: this method accepts exactly `{}`), never when
it encodes what an authority permits.

## Modules

| Module | What it owns |
| --- | --- |
| `compat.ts` | `ACP_PROTOCOL_VERSION`, `ACP_V2_DRAFT_REVISION`, `REDSKILLS_WIRE_MAJOR`, the two gates that refuse an incompatible peer, and the v1 → v2 session-update translation. |
| `transport.ts` | Binding, connecting, streaming and tearing down the local ACP endpoint on both platforms. |
| `methods.ts` | The `_redskills/*` registry and the params shape shared by the methods that take none. |
| `go-dispatch.ts` | The `go_dispatch` params, answer, published schema and params validator. |
| `worktree.ts` | The `worktree_add` / `worktree_list` params, answers, published schemas, params validator and refusal vocabulary. |

## Ownership guard

`apps/dev/tests/acp-adapter-ownership-guard.test.ts` greps the daemon and
adapter sources for a re-grown copy of any of the four agreements above, and
for a `_redskills/*` literal spelled outside this package's registry. It runs in
every gate through `pnpm -C apps/dev test:invariants`.
