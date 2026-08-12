# Setup RedSkills Interview Reference

## Present findings and ask

Summarise what's present and what's missing. Then walk the user through the sections **one at a time** — present a section, get the user's answer, then move to the next. Don't dump all sections at once.

Assume the user does not know what these terms mean. Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

**Section A0 — Plugin activation — ask first (the per-directory gate)**

> Explainer: RedSkills plugins (`dev`, `memory`, `brain`) install their hooks **globally** on every agent (Claude Code, Codex, opencode), but they must only act in repos that explicitly opt in. Each plugin's hook launcher checks, before doing anything, whether the current directory's `.red/config.yaml` sets `plugins.<name>.enabled: true` (ADR 0067, strict opt-in). No `.red/config.yaml` → every RedSkills plugin stays fully inert here (no bundle fetch, no hooks, no side effects). A `plugins.<name>` block alone is **not** enough — the flag must be the explicit `true`.

Ask the user which plugins to enable in this repo (multi-select; `dev` is the usual baseline):

- **dev** — the engineering stack: `/afk`, `/triage`, `/go`, model-tier routing, branch-lock, statusline. Enabling it is what makes the rest of this setup meaningful; default yes.
- **memory** — governed operational memory (recall/store/graph). After enabling, run `/memory:init` to choose the storage mode. Default no.
- **brain** — the agentic command-center context. Default no.

Record the choice; it drives the `plugins:` block written in step 4. Disabling a previously-enabled plugin is also valid here — set its flag to absent/`false`. Creating `.red/` (if missing) is authorized by this section; never create it just to host one of the other sections — if the user enables no plugins, write nothing.

**Section A — Issue tracker.**

> Explainer: In every reddb.io repo, issues and Specs **always** live on GitHub Issues. Skills like `to-tickets`, `triage`, `to-spec`, and `qa` call `gh issue create` / `gh issue edit` directly. There is no local fallback and no support for other trackers — this is a project-wide policy.

Confirm that `git remote` points to a GitHub repo, then proceed with the `issue-tracker-github.md` seed. If the repo has no GitHub remote, stop and ask the user to configure one before continuing.

**Section B — Triage label vocabulary.**

> Explainer: When the `triage` skill processes an incoming issue, it moves it through a state machine — needs evaluation, waiting on reporter, ready for an AFK agent to pick up, ready for human decision/resolution, dependency-blocked, or won't fix. To do that, it needs to apply labels (or the equivalent in your issue tracker) that match strings *you've actually configured*. If your repo already uses different label names (e.g. `bug:triage` instead of `needs-triage`), map them here so the skill applies the right ones instead of creating duplicates. Labels should belong to a clear family: current state, permanent type, priority, relationship/dependency, or operational diagnostic.

The canonical state roles:

- `needs-triage` — maintainer needs to evaluate
- `needs-info` — waiting on reporter
- `ready-for-agent` — fully specified, AFK-ready (an agent can pick it up with no human context)
- `ready-for-human` — needs human decision/resolution before it can proceed or be delegated
- `blocked:dependency` — waiting on other issues (via `req:N` edges); never pages a human; auto-unblocks when the last dep closes
- `wontfix` — will not be actioned

Do not provision or preserve labels outside the accepted label families; HITL/AFK routing is represented by `ready-for-human` / `ready-for-agent`.

Default: each role's string equals its name. Ask the user if they want to override any. If their issue tracker has no existing labels, the defaults are fine.

**Section C — Domain docs.**

> Explainer: Some skills (`improve-codebase-architecture`, `diagnose`, `tdd`) read a `.red/CONTEXT.md` file to learn the project's domain language, and `.red/adr/` for past architectural decisions. They need to know whether the repo has one global context or multiple (e.g. a monorepo with separate frontend/backend contexts) so they look in the right place.

Confirm the layout:

- **Single-context** — one `.red/CONTEXT.md` + `.red/adr/` at the repo root. Most repos are this.
- **Multi-context** — `.red/CONTEXT-MAP.md` at the root pointing to per-context `.red/CONTEXT.md` files (typically a monorepo).

**Section D — Workflows.**

> Explainer: RedSkills ships GitHub Actions workflows that close gaps in the manual flow. The most important one is `red-issues-needs-triage.yml` — it auto-applies the `needs-triage` label to any newly opened or reopened issue that has no labels yet, so fresh reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). When we **install** a workflow into a consumer repo we rename it `red-skills-<name>.yml` so the adopter can tell our workflows from its own CI. The rename is filename-only — see [WORKFLOWS.md](./WORKFLOWS.md) for the full three-prefix convention (`reusable-*` reusables / `rs-*` installed copies / `red-*` red-skills' own CI).

This section is a **menu, not an all-or-nothing**. Ask the user which workflows they want and, for any opt-in lane, which configs — never install a lane the user didn't pick. Default each workflow as marked below and let them override.

Confirm with the user:

- Install `red-issues-needs-triage.yml` (verbatim — name unchanged; it is a standalone `red-*` copy-installable, not a reusable caller) into `.github/workflows/`? Default: yes.
- Does the `needs-triage` label exist in the issue tracker? If not, create it (`gh label create needs-triage --description "Maintainer needs to evaluate"`).
- Does the `quarantine` label exist? If not, create it idempotently (`gh label create quarantine --color D93F0B --description "Issue-local AFK safety hold; Issue curator releases or parks for HITL"`). ADR 0122 boot probes apply this label instead of halting the drain on one incoherent issue.
- Does the `runner-error` label exist? If not, create it (`gh label create runner-error --color B60205 --description "AFK supervisor circuit-tripped; runner was misconfigured"`). The `/afk` fleet supervisor falls back to creating it on the fly during a circuit trip, but provisioning it here keeps colour/description consistent across repos.
- Does the `blocked:dependency` label exist? If not, create it (`gh label create blocked:dependency --color D4C5F9 --description "Waiting on other issues (req:N edges); auto-unblocks when the last dependency closes"`). `req:N` edge labels are created on demand by `/to-tickets` (`gh label create req:<n>`) like `spec:N`, so they need no upfront provisioning.
- Provision the Wayfinder labels `/wayfinder` uses to type map and child Tickets. The map label is plain (`gh label create wayfinder:map --color C5DEF5`); the **ticket TYPE labels go through the installer, never bare `gh label create`** — `npx -y -p @reddb-io/red-skills@<version> red-skills-dev install-type-labels` creates `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, and `wayfinder:task` **and** declares the HUMAN-ONLY ones (`wayfinder:grilling`, `wayfinder:prototype`) in `plugins.dev.afk.labels.hitl_types`. Installing the labels without that declaration leaves the repo looking protected while unblocked decision Tickets enter the autonomous queue (issue #3013) — see triage-labels *HUMAN-ONLY types*. AFK routing still comes only from `ready-for-agent` / `blocked:dependency`, and HITL routing from `ready-for-human`.
- Provision the typed **blocked-reason** labels `/afk` applies to describe *why* an iteration stopped (it falls back to creating each on the fly, so this only keeps colour/description consistent): `gh label create blocked:quota`, `blocked:runner-transient`, `blocked:merge-conflict`, `blocked:ci`, `blocked:spec`, `blocked:validation`, `blocked:crashed`, `blocked:policy`, `blocked:stalled`, `blocked:infra` (suggested colour `E99695`, descriptions per the *Blocked Reasons* table in triage-labels). These are descriptive (added alongside the routing label) — see triage-labels.
- Does the `landing:manual` label exist? If not, create it idempotently (`gh label create landing:manual --color FBCA04 --description "AFK runs the full pipeline + opens the PR, then holds for a human's merge click (no auto-merge)"`). A `ready-for-agent` issue carrying it stays in the autonomous `/afk` lane but parks `ready-for-human` with the open PR instead of auto-merging — so agent-codable slices that must not be auto-merged (e.g. changes to AFK's own landing/claim machinery) no longer have to be hand-dispatched via `/go` (issue #1049). `/triage` may set it at brief-writing time; `/hitl`'s **delegable-manual-landing** disposition routes an issue here.

**Autonomous AFK execution lane (opt-in — default NO).** Beyond auto-triage, RedSkills can run `/afk` itself **from GitHub Actions** — one attempt per issue, opening a PR with no human at a terminal (the "offline" / headless lane, ADR 0059/0062). This is a bigger commitment than auto-triage, so it is **off by default**. Offer it, defaulting to no:

- Install the AFK Actions lane (the caller, as `rs-afk-attempt.yml`) into `.github/workflows/`? **Default: no.** Explain the prerequisites before a yes, and ask which configs to use:
  - **Secrets** — one OpenCode auth key as a repo secret. Ask which provider the user runs, then which key to wire (first set wins): `MINIMAX_API_KEY` (`minimax/<model>`), `OPENAI_API_KEY` (`openai/<model>`), or `OPENROUTER_API_KEY` (`openrouter/<vendor>/<model>`). Without one the lane fires but the agent fails auth. **Public-repo gotcha:** org secrets are *not* shared with public repos by default — if the repo is public, the key must be a **repo secret** or an org secret whose "Repository access" includes this repo, else it resolves empty with no error. Full secret guide: [`../afk/actions-lane.md`](../afk/actions-lane.md#configuring-secrets-per-provider).
  - **Model** — ask which `<provider>/<model>` slug to pin in the caller (e.g. `minimax/MiniMax-M3`), or leave empty to use the repo's `.red/config.yaml` model config.
  - **Trust gate** — ask for the allowlisted issue-author + label-applier logins (you set them). Public repos: keep the allowlist to yourself + your bot.
  - **Triggers** — ask whether they want the manual `workflow_dispatch` caller, the `issues: labeled` auto-trigger, or both. Fires on `ready-for-agent` (labeled, or an issue opened already carrying it) / manual dispatch.
  - Full reference: [`../afk/actions-lane.md`](../afk/actions-lane.md).

Future RedSkills workflows land in this same step, following the same three-prefix convention ([WORKFLOWS.md](./WORKFLOWS.md)).

**Section E — Token efficiency (strongly recommended).**

> Explainer: A huge fraction of an agent's token budget gets burned on noisy CLI output — `git status` on a dirty branch, large `git diff` / `git log` output, verbose `gh` lists, and long test failures. `rsp` is the repo-owned token-efficiency surface: explicit wrappers for supported commands, reversible elision handles for lossy summaries, and an opt-in hook rewrite table that lives in the same binary as the wrappers.

Strong recommendation: enable `rsp` whenever `dev` is enabled. The hook remains inert unless this repo's `.red/config.yaml` has `rsp.enabled: true`; absent that opt-in, agents can still call the explicit wrappers.

Teach the user the wrapper surface:

```bash
rsp git status
rsp git diff --brief
rsp git log --terse
rsp gh pr list --query open
rsp gh issue view 123
rsp vitest --terse
rsp cargo test --brief
rsp show el:<id>
```

The loss levels are:

1. **Default/lossless.** Emit TOON summaries for supported commands. Large `git diff` and `git log` output is threshold-gated and truncates by default when it exceeds the configured byte threshold.
2. **`--brief`.** Prefer a compact inline summary for normal debugging.
3. **`--terse`.** Keep only the smallest useful inline view and mint an `el:<id>` handle for the omitted bytes. `rsp show el:<id>` writes the original bytes verbatim to stdout; expired handles print the original command to re-run.

Three things to verify after setup:

1. **Repo store is provisioned.** `rsp` with no arguments should print store stats. If it says the repo store is not provisioned, finish `/red-setup` so `.red/state/red-skills.rdb` exists.
2. **Config opt-in is explicit.** `.red/config.yaml` should carry `rsp.enabled: true`, `rsp.ttlDays: 7`, `rsp.ephemeralTtlHours: 6`, and `rsp.byteBudget: 67108864` unless the operator deliberately changed retention.
3. **Hook behavior is scoped.** In opted-in repos, the pre-exec hook may rewrite simple supported commands such as `git status`, `gh pr list`, `vitest`, and `cargo test` to their `rsp` forms. In non-opted-in repos, the hook is inert and agents should call `rsp` explicitly only when available.

The per-host ambient instruction surface that replaces legacy host-local terminal guidance is tracked in #1415 and generated from `apps/rsp/generated/AMBIENT-SKILL.md`; do not block setup on it.

The full provisioning story — how the binary reaches a host without a global install, the opt-in knobs, the escape hatches (`RSP_NO_PROXY=1` / `RED_SKILLS_RSP_NO_PROXY=1`), and the failure semantics — is documented in `apps/rsp/README.md` under **Provisioning**.

**Section E1 — Runtime launcher (strongly recommended).**

> Explainer: `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, and similar variables are plugin/hook environment variables. They are not guaranteed in the interactive shell where an agent runs `/afk`, `/go`, `/dashboard`, or `/retake`. Setting those names globally is brittle because they point at versioned plugin-cache directories and can become stale after an update. The cross-CLI surface should be a stable command, not a global fake plugin-root variable.

Offer to install the host-level runtime shim:

```bash
bash plugins/dev/skills/engineering/red-setup/scripts/install-runtime-shim.sh
```

The script writes `${XDG_BIN_HOME:-$HOME/.local/bin}/red-skills-dev` and `${XDG_BIN_HOME:-$HOME/.local/bin}/rsp`. The `red-skills-dev` shim:

- prefers the active CLI plugin-root env var when the host exposes one;
- otherwise finds the latest installed dev plugin under `~/.codex/plugins/cache/red-skills/dev/*` or `~/.claude/plugins/cache/red-skills/dev/*`;
- falls back to the latest warmed dev bundle under `~/.cache/red-skills/bundles/`;
- forwards all arguments to the dev runtime, so skills reach the same cores redskilled `status { scope: worker }`, `dashboard`, and `worker_dispatch` drive. The shim is a **warm-cache optimization over the canonical `npx -y -p @reddb-io/red-skills@<version> red-skills-dev <subcommand>` form** (ADR 0091), never a replacement for it: the same no-MCP fallbacks are `go ...`, `dashboard`, or `RED_AFK_RUNNER=codex … monitor --once`;
- stores no secrets and does not replace the `.red/config.yaml` opt-in gate.

The `rsp` shim uses the same local-first shape: active plugin-root env var, installed host plugin cache, then the warmed rsp bundle under `${RED_SKILLS_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/red-skills/bundles}`. It never runs npm, installs a global package, or performs network resolution during session startup.

After installing, verify:

```bash
command -v red-skills-dev
command -v rsp
npx -y -p @reddb-io/red-skills@<version> red-skills-dev dashboard --json
rsp git status
```

If `command -v` cannot find it, add `${XDG_BIN_HOME:-$HOME/.local/bin}` to the shell `PATH`. Do not export `CLAUDE_PLUGIN_ROOT` or `CODEX_PLUGIN_ROOT` globally as a substitute.

**Section E2 — Required host binaries (mandatory).**

> Explainer: TOON/TOONL files are first-class RedSkills state. `tq` is the jq-for-TOON CLI published as the official `reddb-io-tq` crate; after ADR 0097 there is no jq fallback for RedSkills-owned TOON/TOONL logs. A host without the pinned `tq` cannot inspect its own TOONL state, so setup installs the binary and records the expected version for `/red-doctor`.

Install the pinned `tq` through the official Rust package manager:

```bash
cargo install reddb-io-tq --version 0.22.0 --locked --force
```

Then verify:

```bash
tq --version
```

The installed version must be at least `0.22.0`. Record the same floor in `.red/config.yaml` under `host_binaries.tq.version` so `/red-doctor` can red-flag absence or drift and print the same package-manager fix. Do not document or offer a jq fallback.

**Section E3 — Execution daemon (`redskilled`) — mandatory when `dev` is enabled.**

> Explainer: `redskilled` is the host-scoped execution daemon (ADR 0130): exactly one singleton per machine, behind a unix socket, owning Worker processes across every project on this machine while each project's bundle keeps owning the work. It is what makes "what is this machine currently doing" answerable, and it fails closed — no daemon, no Worker. A daemon starts on first use, and two things must exist before it can: a published bundle to run and a socket that answers.

**The home is the daemon's, not this skill's.** `~/.red/redskilled/` and the host policy at `~/.red/config.yaml` are operator-scoped and live outside every checkout, so they are *not* the `.red/` this skill has sole authority over. Their one creator is `provisionRedskilledHome` in `apps/redskilled/src/provision.ts` (ADR 0130 Amendment 1) — never `mkdir` or write them here, and never treat a repo's ADR 0067 authority as covering them. Setup provisions them by **calling** their owner:

```bash
npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision
```

The npm direct-run form above is canonical (ADR 0091): it pins the version and
works on a host that has never seen this daemon, which is exactly the host being
set up. An installed `redskilled` shim on `PATH` is a warm-cache optimization,
never a precondition — instructing an operator to run the binary that only
exists after the thing it installs is the dead end #2961 closed.

That one command starts the daemon through the ordinary client path and prints the audit as TOON. **It is idempotent**: a second run creates nothing and rewrites nothing, so run it on every setup pass rather than only when something already looks wrong. Three flags matter:

- `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --check` — the read-only half. Reports without creating anything or starting anything; this is the shape `/red-doctor` consumes.
- `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --workspace <target>` — states the workspace target outright instead of reading this repo's config. Run it with `host` at the moment the user selects the `host` preset.
- `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --install-unit` — writes the optional supervising unit (below). Off unless the user asks for it.

**The state home is created only when a lane reads it.** The daemon never resolves `~/.red/redskilled/`; the only reader is a workspace lane rooted inside it (`plugins.dev.workspace.target: host`, or a custom parent under the home). On the default `local` preset the command creates no state directory, reports `needed: false` with the declaration that decided it, and the machine is fully provisioned — **do not treat an absent `~/.red/redskilled/` as a defect** (#2958). The daemon separately reads machine policy from `~/.red/config.yaml`. When provisioning creates that file it writes only the initial template and never overwrites operator settings. Machine policy belongs under `plugins.dev.redskilled`; repository files carrying those keys warn and are ignored. Resolution is `serve` flag > environment > home config > derived default, and `host-state.ceiling` reports which source won. Provisioning is therefore never on the critical path of "have a daemon": auto-spawn already is.

Verify afterwards:

```bash
RS="npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled"

$RS provision --check      # verdict: ok
$RS host-state             # the machine's Workers, from the daemon itself
```

A `verdict: missing` names which of the four checks failed — `home`, `daemon-entry`, `reach`, `supervisor-unit` — and prints the exact command for each. A `home` finding appears only when a declared target actually reads the home; absent-and-unneeded is reported as `ok`. A `daemon-entry` finding means no published bundle was found on this host; it names every path probed, and re-running `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision` after the bundle is warmed is the cure. Do not work around it by pointing the daemon at a caller's own entry — a stale caller mints a staler daemon and the skew widens (#2736, #2677).

**Optional supervising unit (default NO).** Auto-spawn already starts the daemon on first use; the user unit only adds `Restart=always` over the identical binary, socket and contract (ADR 0130 rule 7). Offer it, defaulting to no, and only on a Linux host with a `systemd --user` session. On a yes:

1. Run `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --install-unit`. It writes `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/redskilled.service` **only when absent** — an existing unit is the operator's configuration and is never rewritten.
2. Tell the user the two commands that activate it; do not run them for them:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now redskilled.service
   ```

An absent unit is never a defect — `/red-doctor` reports it as `ok` with a stated absence, because auto-spawn is the supported start path either way.

**Section F — RedSkills statusline (optional).**

> Explainer: RedSkills has one shared statusline producer in the dev bundle: the `statusline` subcommand reads each worker's `.red/tmp/workers/*/*/afk.state.json`, filters by `kill -0` liveness, sums diffstats locally, and caches GitHub-derived counts for 60 s to stay under the ~100 ms refresh budget. Host adapters differ. Claude Code can run that producer through a command-backed `statusLine`, so it can show live worker count, queue depth, and aggregated diffstat at a glance. Codex currently exposes native `tui.status_line` footer widgets instead of a command hook; under Codex, use `$red-statusline` to inspect or configure the footer and rely on `/afk monitor` for the live AFK block.

Decide whether to wire it up for this project:

- **Skip when** the per-project plugin config (`.red/config.yaml`) sets `afk.statusline: false`. Detect with `grep -qE '^[[:space:]]*statusline:[[:space:]]*false[[:space:]]*$'` on the `afk:` block (or use `yq` if available). When skipped, log a one-line notice (`afk.statusline: false in .red/config.yaml — skipping statusline wiring`) and move on.
- **Skip when** a `statusLine` entry is already present in `.claude/settings.json`. Do **not** overwrite — log a one-line notice (`statusLine already configured in .claude/settings.json — leaving as-is`) so the user can decide. Idempotency rule: re-running `/dev:red-setup` must never clobber a hand-edited statusline.
- **Otherwise** write the entry into `.claude/settings.json` (create the file if missing, merge with existing keys via `jq` if present):

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "sh -c 'N=$(command -v node 2>/dev/null || ls -1 /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node \"$HOME\"/.volta/bin/node \"$HOME\"/.asdf/shims/node \"$HOME\"/.nodenv/shims/node \"$HOME\"/.nvm/versions/node/*/bin/node \"$HOME\"/.local/share/fnm/node-versions/*/installation/bin/node \"$HOME\"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -1); [ -z \"$N\" ] && exit 0; b=$(ls -1 \"$HOME\"/.cache/red-skills/bundles/dev-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -z \"$b\" ] && b=$(ls -1 \"$HOME\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | sort -V | tail -1); if [ -n \"$b\" ]; then \"$N\" \"$b\" statusline; else echo \"redskilled unreachable — Worker state unknown\"; fi; exit 0'",
      "refreshInterval": 60
    }
  }
  ```

  Do **not** use `$CLAUDE_PLUGIN_ROOT` here: Claude Code does not export it (nor `$CLAUDE_PROJECT_DIR`) to a `statusLine` command — only to plugin hooks and MCP/LSP subprocesses — so that form expands to an empty path and renders blank. Likewise, the command resolves `node` explicitly rather than a bare `exec node`: Claude Code runs the statusLine in a **non-interactive shell** that does not source the user's shell rc, so a Node installed through a version manager (nvm, fnm, volta, asdf, nodenv, …) is off `PATH` and bare `exec node` fails with `node: not found` — another silent blank. `command -v node` covers every host with Node on `PATH` (system package, Homebrew, no version manager); only when that misses does it scan the common install roots, newest wins. The command above is **cached-bundle-first**: it resolves the **highest-version already-fetched runtime bundle** (`ls -1 …/.cache/red-skills/bundles/dev-*.bundle.min.mjs | sort -V | tail -1` — `sort -V` picks the highest semver, NOT `ls -t | head -1` which picks newest-by-mtime and can resolve an OLD version when an older dir was touched/re-extracted more recently), and only falls back to the launcher `afk.mjs` from the plugin cache when no bundle is cached yet (first-ever install). Resolving the cached bundle directly keeps the network out of the hot path: since ADR 0038 the launcher does a synchronous download on a cold cache, so pointing the statusline straight at it means **every plugin update** blanks the line until the new bundle is fetched. The cached-bundle-first form keeps showing the last good bundle across updates without pinning a version. The project root is read from `workspace.project_dir` in the JSON Claude Code pipes on stdin (no argument needed). **One producer, and the host prints what it hands back — INTERIM, until #3151.** The dev bundle is asked for the whole line: the repo header and the Worker rows under it. The host formats no Worker and orders no row. This was two producers — the dev bundle muted with `--no-workers`, the daemon's own `statusline` echoed under it, because the daemon owns the Worker line (ADR 0130 rule 10, #2928) — and it will be again. **The delegation was made before the thing delegated to could draw.** Measured against the same live Workers, the daemon's `line` density gave a project label, an id and a memory figure where the dev bundle gives a progress bar, a state colour, aligned `run=`/`org=`/`iss=` columns, `phase·activity`, elapsed, `hb=`, `loc=`, `tks=` and the tool/reason/text vitals. The rich rows were never broken; a flag switched them off, and because every copy of this command is held byte-identical, every repo `/red-setup` touched shipped the poorer line at once (#3166). So the delegation is on hold until **#3151** rewrites the daemon's `line` density to carry that row. Do not restore `--no-workers` or the daemon half before then — `apps/dev/tests/statusline-command-doc.test.ts` and `apps/redskilled/tests/statusline-host-adapter.test.ts` both refuse it, and both name #3151. What holds either way is the count: **exactly one renderer draws a Worker row.** A host with no renderer at all prints a stated absence rather than nothing, because a blank line is indistinguishable from a machine with no Workers: the command's `else` branch prints "redskilled unreachable — Worker state unknown" — the same sentence the daemon's own `statusline` prints when its socket does not answer, so the operator reads one absence however deep the failure is (#3074). That `else` branch is not the host rendering a Worker row — ADR 0130 rule 10 holds, and there is no Worker here to render. The runtime bundles reach `~/.cache/red-skills/bundles/` from one npm materialization the `SessionStart` hook already performs, `dev-*` landing beside `rsp-*` and `redskilled-*`; nothing invokes `red-fetch.mjs redskilled <version>` by name, and until #3074 nothing warmed the daemon's copy either, so its glob resolved nothing on every `npx`-provisioned host. It is warmed now and stays warmed — the daemon needs its own bundle whoever draws the statusline — so #3151 restores that glob to a directory already holding the file. **The command ends in `; exit 0` on purpose:** the rendered line is the point, and a host that cannot render one is not a failed command. Without it the last statement is a bare test whose status becomes the whole `sh -c`'s status, so a host with no cached bundle rendered its header correctly and still reported failure (#3073). Write this command **byte-identical** to the copy in the `red-statusline` skill's `HOST-NOTES.md`; `apps/dev/tests/statusline-command-doc.test.ts` fails when the two drift or when either can still exit non-zero. This subsection writes only the Claude Code adapter; the shared producer remains host-agnostic, and Codex's adapter lives in the `red-statusline` skill because it edits global `~/.codex/config.toml` rather than repo-local `.claude/settings.json`.

**A statusline written here takes effect in the next session, not this one.** Claude Code loads `.claude/settings.json` at **session start**, so the entry just written is on disk and not in the running process — the line stays blank until the user starts a new session, and nothing in the host says why. That silence is what makes "the statusline does not work" the guaranteed first experience of a freshly set-up repo, and every check the user then runs comes back clean because the file is right and only the process is stale (#3075). Report it in the recap, and only when this run actually wrote the key: either skip above changed no setting and has no restart to ask for. `/reload-plugins` is not the cure — it reloads plugins, not project settings.

The script is no-op outside `/afk` sessions (it prints nothing when no live workers exist), so leaving the statusline wired up in non-AFK projects is harmless.

**Section G — `.red/config.yaml` template (automatic).**

> Explainer: `.red/config.yaml` is the per-project knob file that `/afk` and friends read at runtime. It holds the project's fallback runner, default fleet target, and per-detector opt-outs. The schema is documented by the loader shipped in PRD #16 and is forward-compatible (unknown keys are ignored). A fresh repo should land with a *commented* template of every v1 knob so the user discovers the available settings without reading docs — the file is a no-op until lines are uncommented.

No user decision here for the template itself — the skill scaffolds it whenever the file is missing. The one piece that is **not** optional is the `plugins:` activation block from Section A0: the file must carry `plugins.<name>.enabled: true` for each plugin the user enabled, or the globally-installed hooks stay inert (ADR 0067). If `.red/config.yaml` already exists, leave its existing content alone (any prior edits are project state — never clobbered) except for the write contract's explicit surgical exceptions, including plugin activation and the confirmed Worktree setup authority below. See step 4 for the write rule.

**Task-class routes — propose, then confirm.** Show the four task classes (`validate`, `simple`, `complex`, `think`) and ask whether any should use a runner other than `afk.default_runner`. For every mapped class, ask for the runner and offer the selected runner's shipped model/effort pair; let the operator accept that fallback or pin `model` and `effort` beside `runner` in the same `plugins.dev.afk.routes.<class>` block. Explain the precedence before confirmation: explicit `--runner` > `RED_AFK_RUNNER` > a runner named by `project_start` > the class route > `default_runner`; model/effort flags and env overrides likewise beat the file. Show the complete proposed YAML and write it only after explicit confirmation, on both fresh and existing configs. An unmapped class is intentional and keeps today's `default_runner` behaviour.

**Worktree setup authority — inspect, propose, then confirm.** AFK redirects each Worker and feedback Worktree's `core.hooksPath` so consumer commit hooks do not fire inside automation. Dependency installation is repository policy for the same reason the merge gate is repository policy: the engine cannot know whether this repo uses pnpm, bun, Corepack, or a lifecycle script that performs a real build. Inspect root lockfiles, `package.json.packageManager`, Corepack metadata, and `prepare` plus dependencies/devDependencies for `lefthook` or `husky`. Then show the detected facts and ask the user to confirm the exact ordered command(s) written under `plugins.dev.afk.setup`.

Propose the detected package manager's frozen install by default. When a hook manager is detected, include its supported opt-out because its installer refuses AFK's redirected hook path: `LEFTHOOK=0` for lefthook, `HUSKY=0` for husky, or both when both are present. Examples: `LEFTHOOK=0 pnpm install --frozen-lockfile`, `HUSKY=0 npm ci`, or `bun install --frozen-lockfile`. Do not add `--ignore-scripts` by default when `prepare` performs a real build; the declaration exists precisely so the maintainer can keep required lifecycle work. The engine executes confirmed commands verbatim and never appends flags or substitutes another package manager. This confirmation applies on fresh and existing configs: setup authority is a surgical, user-approved exception to no-clobber, not a best guess hidden in the runtime.

**Validation moments — discover, propose, then confirm.** Inspect the repository's package manifests (root plus every package selected by its workspace declaration). Present a compact harness inventory naming each package/path, the detected package manager, and the exact `test`, `typecheck`, `lint`, and `build` scripts that actually exist. Do not invent a missing script or hide a package behind a generic “tests found” summary.

Use that inventory and the repository's CI/merge-queue evidence to show a proposed `plugins.dev.afk.validation` block. Explain the lifecycle beside the proposal: `iteration` gives the inner agent the operator's light checks while writing; `post_done` runs against the branch's fork point after DONE; `landing` runs before push/PR/queue; and the merge queue is the CI-side final Validation moment that checks the merged result. If there is no merge queue, explicitly offer a fuller `landing` list. An omitted moment skips loudly; `[]` is an explicitly declared empty list. Do not silently copy the full discovered suite into every moment — propose which exact package-manager invocations belong at each point and let the operator move, add, remove, or omit them.

Show the complete YAML proposal, including ordered command lists, and ask the operator to confirm or edit it. Say plainly that `/red-setup` will write it only after explicit confirmation. This confirmation gate applies to a fresh or existing `.red/config.yaml`: without a yes, leave the validation schedule untouched. Legacy `afk.feedback.commands` and `afk.backpressure` entries may be reported as deprecated aliases of `post_done`, but never propose or add those aliases.

**Release standard — choose, detect, propose, then confirm.** A release consumes the Validation moments just declared: only a revision that passed those checks should be tagged, and the release workflow can reuse the confirmed build commands. Explain that the Release standard keeps changesets-compatible files in `.changeset/`, puts the whole workspace on one product version, and publishes human notes plus JSON and TOON release manifests instead of committing a `CHANGELOG.md`.

Walk the operator through these choices in order:

1. **Scheme:** `semver` or `calver`. Calver is exactly `YYYY.M.MICRO` with no leading zeros (for example `2026.8.2`), so it stays semver-parseable. Under calver, a changeset's major/minor/patch value is an impact class for notes and manifest metadata, not version arithmetic.
2. **Trigger:** `version-pr` (default) or `auto`. In `version-pr` mode the engine maintains one reviewable Version-PR and its merge triggers the stable tag. In `auto` mode the same queue is consumed directly on push.
3. **Pre-release:** choose pre-release enablement or disable it (default disabled). When enabled, an RC is cut from the Version-PR's own branch as `X.Y.Z-rc.N`; merging that same branch graduates the tested bytes to stable.
4. **Execution:** pinned npx (default, persisted as `pinned`) or `vendored`. Pinned execution keeps generated workflows thin and invokes the versioned release binary through the canonical npx form. Vendored execution emits the single-file engine bundle into the consumer repository for restricted CI and runs that file without a runtime package download.

Explain the release credential prerequisite before proposing the config: the generated tag-cutting job requires a repository secret named `RELEASE_PAT`, containing a credential that can write repository contents and whose pushes may start downstream workflows. The workflow keeps API calls on `GITHUB_TOKEN` and uses `RELEASE_PAT` only as the checkout-persisted Git push identity. Ask the operator to provision it before the first release; when it is absent, the job fails at checkout before creating a tag or GitHub Release.

Then run the Version surfaces **detect, propose, then confirm** pass:

1. Detect every workspace manifest that already carries the product version: root and workspace `package.json` files as `npm`, and root and member `Cargo.toml` files as `cargo`. Inspect an existing `release.version_surfaces` declaration too; do not lose an operator-declared exotic surface on rerun.
2. Present the detected path and format for every surface. Separately ask whether the repository has extra carriers such as an extension manifest, embedded constant, or plain version file; propose each extra path with format `npm`, `cargo`, or `text`. When an exotic carrier needs repository-owned propagation logic, propose one optional `release.sync_command` instead.
3. Show the complete proposed top-level `release.*` YAML block: `scheme`, `trigger`, `prerelease`, `execution`, the non-empty `version_surfaces` list, and optional `sync_command`. Explain that the release engine re-derives the real npm/Cargo workspace at release time and refuses drift while naming an orphan package.
4. Ask the operator to confirm or edit every answer and surface. Say plainly that `/red-setup` writes the block only after explicit confirmation, for a fresh or existing `.red/config.yaml`; without a yes, leave `release.*` untouched.

**Section G1 — Command guards (offer-only).**

> Explainer: RedSkills ships the maximum practical shell-command hook coverage for each supported CLI (Claude Code, Codex, and opencode). Those hooks are **proxy guarantees**, not the policy source: they extract the command and cwd, find the repo root, read `.red/config.yaml`, then evaluate `command_guard`. This keeps AFK workers and the main interactive session on the same repo-owned policy, and it keeps per-CLI hook files as thin adapters instead of places where safety rules drift.

Built-in invariant: when `plugins.dev.enabled: true`, the dev proxy always enforces the RedSkills worktree boundary before any repo-authored `command_guard` rule runs. Agent-created `git worktree add` destinations must resolve under a registered lane in the repo's `.red/tmp/`, and branch-moving commands in the primary checkout (`git switch`, `git checkout <branch>`, `git checkout -b`, `git switch -c`, `gh pr checkout`) are blocked so interactive work starts with `git worktree add .red/tmp/worktrees/manual/<slug> -b <branch> ...`. This invariant is not written into `command_guard` and has no example defaults to copy; it is part of enabling `dev`.

Offer to configure additional `command_guard` rules now. Default: **no extra active rules** unless the user confirms specific commands. Examples are examples only — do not write them as defaults.

Explain the scopes:

- `global` — blocks in both the main session and `/afk`/`/go` worktrees.
- `main` — blocks only in the primary interactive session scope. This does **not** mean the Git branch named `main`.
- `worktree` — blocks only in RedSkills runtime worktrees under `.red/tmp/`, including AFK workers.
- `deny` — legacy alias for `global`; keep it readable but prefer writing new config as `global`.

Explain the matcher forms:

- Bare strings match the exact command, a command prefix, or a command suffix at a shell-command boundary.
- Bare strings with `*`, `?`, or `[` are Bash globs.
- Explicit modes are `regex:<pattern>`, `re:<pattern>`, `prefix:<literal>`, `suffix:<literal>`, `exact:<literal>`, and `glob:<pattern>`.

When the user wants starter examples, present a draft like this and let them edit before writing:

```yaml
command_guard:
  global:
    - "rm -Rf /*"
    - "git stash"
  main:
    - "git rebase"
    - "git checkout -b"
  worktree:
    - "git clean"
```

Do not write the example blindly. The right policy is repo-specific.

**Section H — Development workflow.**

> Explainer: RedSkills' interactive dev loop assumes agents work from isolated worktrees, leave the primary checkout's branch alone, push their branch early, and land via a PR — with one-off concrete work dispatched through `/go` rather than hand-rolled worktrees. With `plugins.dev.enabled: true`, the shell proxy already blocks agent-created worktrees outside registered `.red/tmp/` lanes and branch movement in the primary checkout. Turning on `plugins.dev.lock.primary-branch: true` in `.red/config.yaml` also activates the branch-lock compatibility flag used by older adapters and base-pinning integrations; the runtime folds it onto the legacy `dev.lock.primary-branch` accessor for back-compat. The shared development-workflow injector writes the same `## Development workflow` rules into both `AGENTS.md` and `CLAUDE.md`, updating an existing block in place on rerun.

Confirm with the user:

- Activate the development workflow? Default: yes.
- This sets the canonical `plugins.dev.lock.primary-branch: true` flag in `.red/config.yaml`.
- This writes or updates `## Development workflow` in both `AGENTS.md` and `CLAUDE.md` via the shared injector.
- Recap that one-off concrete work is dispatched with `/go "<demand>"` (worktree + gate + PR handled by the engine), and that hand-worked branches land via a normal PR.

**Section I — Hook scripts from repo signals (offer-only).**

> Explainer: RedSkills hook scripts run at fixed AFK lifecycle points — before merging (`pre_merge`), after merging (`post_merge`), etc. — letting you gate or react to each iteration without editing the AFK runtime. Rather than asking you to configure these from scratch, this step scans your repo for concrete signals (a `package.json` with test/lint scripts, a `Makefile`, a Slack webhook env var, and so on) and offers to seed matching `red-*.sh` scripts into `.red/hooks/<point>/`. Each confirmed script is also registered in `.red/config.yaml` under `afk.hooks.<point>`. Nothing is written without explicit confirmation; no existing script is ever overwritten; nothing is `git add`ed. If no signals are found, this section is silent — absence of signals means no offer.

Scan for concrete repo signals in this order:

1. **`package.json` `scripts.*`** — look for keys named `test`, `typecheck`, `type-check`, `lint`, `build`, `e2e`, or `test:e2e`. Infer the package manager from the first lockfile found (`pnpm-lock.yaml` → `pnpm run`, `yarn.lock` → `yarn run`, else `npm run`). `e2e`/`test:e2e` goes to `post_merge` (too costly as a pre-merge gate); all others go to `pre_merge`.
2. **`Makefile`** — parse top-level targets; offer `pre_merge` hooks for any target named `test`, `check`, `verify`, `lint`, or `build`.
3. **`Cargo.toml`** — offer a `pre_merge` hook running `cargo test` (the built-in default handles Rust worktree isolation; this adds the test run).
4. **`build.gradle` / `build.gradle.kts`** — offer a `pre_merge` hook running `./gradlew check` (the built-in default handles Gradle isolation; this adds the check step).
5. **`.husky/` directory** — offer a `pre_merge` hook running `npx lint-staged`.
6. **`.pre-commit-config.yaml`** — offer a `pre_merge` hook running `pre-commit run --all-files`.
7. **`.env.example`** — scan for `SLACK_WEBHOOK_URL` or `SLACK_INCOMING_WEBHOOK`; offer a `post_merge` Slack notification hook.

If no signals are detected, skip this section entirely — present no table, ask nothing.

If signals are found, present an offer table listing each suggestion:

| Point | Script | Signal |
|-------|--------|--------|
| `pre_merge` | `.red/hooks/pre_merge/red-run-tests.sh` | `package.json scripts.test = "vitest"` |
| `pre_merge` | `.red/hooks/pre_merge/red-lint.sh` | `package.json scripts.lint = "eslint ."` |
| `post_merge` | `.red/hooks/post_merge/red-slack-notify.sh` | `SLACK_WEBHOOK_URL in .env.example` |

Ask the user which to confirm (all, none, or pick by number). Skip the offer for any path that already exists — log a notice and move on (no-clobber, no overwrite, no second ask).
