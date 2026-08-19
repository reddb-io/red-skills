# `@reddb-io/worker` — the Worker body

**This package is what runs INSIDE one admitted Worker process, and nothing
else** (ADR 0148). Whether, when and where a Worker exists belongs to the
`redskilled` daemon; agent and sandbox providers, worktree materialisation, the
gate runner and the turn loop belong here. `README.md` states the mission; the
sandcastle documentation below it is the library reference.

Use `npm run typecheck` for type checking.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

## Vendored source — archived upstream marker

This is reddb.io's vendored fork of sandcastle, consumed by `red-skills` as a
normal monorepo workspace package built from source (`@reddb-io/worker` is a
`workspace:*` dependency — see ADR 0061 and ADR 0101 in red-skills). The
standalone `reddb-io/red-castle` repository is archived after the vendoring
import; `.upstream` is the only upstream marker for the original sandcastle
history and reviewed SHA.

There are **no changesets, no standalone release workflow, and no standalone
CI** for this package — do not add them back. The real gate is red-skills' own
CI on the consuming bundle plus this package's own package checks when its
source changes.

When changing public-facing behavior, check `README.md` to see if the
documentation needs updating.

## TOON is the log doctrine — structured output is never JSON here

**Every structured log lane and every piece of package-authored internal
communication is TOON/TOONL via the pinned `@reddb-io/toon` package — never
JSONL.** This is a deliberate, permanent divergence from upstream sandcastle,
which writes JSON throughout its logs; TOON is markedly cheaper in tokens for
the agents that read these files back (red-skills ADR 0097 records the
measured deltas and the wider on-disk doctrine this fork follows). The
liveness lane was the first conversion; any NEW structured line-per-record
lane or machine-readable output added here must be born TOONL (streams) or
TOON (single documents), with a per-line sniffing reader (JSON first, TOON
fallback) so files written before a conversion still read.

Exempt by contract, do not "fix" them: the raw agent-output firehose sink
(agent-owned bytes passed through verbatim — re-encoding would corrupt them),
prose session logs (human-readable text, not records), and agent-owned session
transcript formats. The single sanctioned non-TOON file the stack writes is the
repo config YAML `.red/config.yaml` (its protocol owner sets the format).

Whole-document snapshot state files are TOON too (issue #2008): the castle
`state.toon` snapshots plus the fleet-runtime snapshot surfaces in the consuming
`apps/plugin-dev` workspace — the worker identity stamp (`identity.toon`), the
per-attempt worker state (`afk.state.toon`), the supervisor state snapshot
(`state.toon`), its restart ledger (`restarts.toon`), and the monitor log-cursor
snapshot (`monitor-log-cursors.toon`). The supervisor files live under the
project's single lane, `.red/tmp/supervisors/default/` — there is exactly one, not
one per fleet (ADR 0130); readers sniff JSON-then-TOON so a file written
by an older bundle still reads.
Converting a NEW snapshot is a deliberate change with its own reader plan, not a
drive-by. The `apps/plugin-dev` uniformity test (`castle-engine-toon-uniformity.test.ts`)
enumerates these writers and fails on any raw-JSON emission.

## `.red-castle` is the on-disk directory identity

**The runtime's on-disk directory — the config directory in a host repo and
every host-derived artifact under it (`.red-castle/worktrees/`,
`.red-castle/.env`, `.red-castle/logs/`, `.red-castle/patches/`) — is named
`.red-castle/`.** This is a deliberate, permanent divergence from upstream
sandcastle, which scaffolds and reads a dot-directory named for its own brand;
the `CONFIG_DIR` constant and every emitted path here carry the reddb.io
identity instead. Only the dot-directory moved — the `sandcastle` CLI/binary
name, the package name, and the exported symbols keep the upstream brand.

**Cherry-picks must be adapted to this identity on adoption**: an upstream
commit that adds or edits a config-directory path arrives with the upstream
brand's dot-directory name — rewrite each such path to `.red-castle/` in the
same sync change, never adopt the upstream directory name verbatim.

## Pruned provider surface — RedSkills' development shape only

**This fork ships only the providers RedSkills actually runs: the Docker,
Podman, and `noSandbox` sandbox providers, and the `claudeCode`, `codex`,
`opencode`, and `pi` agent providers.** This is a deliberate, permanent
divergence from upstream sandcastle, which also ships Vercel and Daytona
sandbox providers and Cursor, GitHub Copilot CLI, and Devin agent providers.
The engine's `RUNNER_SPECS` only ever selects the `claudeCode`/`codex`/
`opencode` factories (`pi` is retained for the implementer-environment
projection), and RedSkills sandboxes exclusively on local container runtimes —
every pruned provider was public surface with zero consumers, paid for on each
upstream sync and each test run. The public `SandboxProvider`/`AgentProvider`
seams remain, so any pruned integration can live outside the package.

**Cherry-picks must be adapted to the pruned surface on adoption**: an upstream
commit that adds or edits the Vercel/Daytona sandboxes or the
Cursor/Copilot/Devin agent providers (or their tests, init-scaffold menu
entries, Dockerfiles, or docs) is dropped for those paths in the same sync
change — never re-adopt a pruned provider verbatim. Re-adding one is a
deliberate decision that must revisit `.out-of-scope/built-in-agent-providers.md`
and `.out-of-scope/built-in-sandbox-providers.md`, not a sync side effect.

## Upstream sync — `.upstream` marks the last reviewed sandcastle commit

This fork tracks `mattpocock/sandcastle` via the `upstream` remote. The
`.upstream` file records the last upstream commit whose history has been
reviewed for adoption — never re-review history older than that SHA. To sync:
`git fetch upstream`, review `git log <sha-in-.upstream>..upstream/main`,
cherry-pick anything worth adopting (drop `.changeset/` files — see above),
then bump the SHA in `.upstream` in the same change. Record adoption verdicts
(taken / skipped and why) in the sync commit message.

**Cherry-picks must be adapted to the TOON log doctrine on adoption**: an
upstream commit that adds or edits a structured log writer arrives JSON-shaped
— convert it to the TOON standard (and give its reader the sniffing fallback)
in the same sync change, never adopt a new JSON lane verbatim.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `mattpocock/sandcastle`; external PRs are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels. Agent provider support is detailed here. See `docs/agents/triage.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
