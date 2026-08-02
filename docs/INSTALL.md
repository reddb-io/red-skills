# Installing RedSkills

The [universal installer](../README.md#install) is the recommended path for
normal installs and upgrades — it detects every supported CLI on the machine and
writes the right surface for each one. This document is the **per-host manual
walkthrough** for the cases the installer does not cover: developing against a
checkout, installing into a single host by hand, or maintaining the generated
manifests.

- [How Updates Reach a Machine](#how-updates-reach-a-machine)
- [Manual: Claude Code](#manual-claude-code)
- [Manual: Codex CLI](#manual-codex-cli)
- [Manual: Gemini CLI](#manual-gemini-cli)
- [Codex Manifest Maintenance](#codex-manifest-maintenance)
- [Pi Manifest Maintenance](#pi-manifest-maintenance)
- [Manual: OpenCode](#manual-opencode)
- [Manual: Pi](#manual-pi)
- [No Marketplace](#no-marketplace)
- [Verify Runners](#verify-runners)

## How Updates Reach a Machine

**A marketplace updates from the source it was registered with — register the
GitHub source and the CLI updates itself.** `/plugin marketplace update
red-skills` re-reads whatever source the registration names:

| Registered source | What `marketplace update` re-reads | Can it see a new release? |
|---|---|---|
| `reddb-io/red-skills` (GitHub) | the repository, pulled from origin | yes — every future release |
| a local directory | that directory, unchanged | no — frozen at whatever it holds |

The universal installer registers the **GitHub** source, so `/plugin marketplace
update red-skills` followed by `/plugin update <plugin>` advances a machine to
the latest published version with no re-install. The local-directory form stays
available for offline and dev installs through `--local-marketplace`
(`RED_SKILLS_MARKETPLACE_SOURCE=local`); it pins the machine to the snapshot the
installer downloaded, which is the point of it.

`--version <tag>` pins the downloaded source cache (what the OpenCode and Pi
surfaces install from), not the marketplace: a GitHub-sourced marketplace always
tracks the repository. Pin the Claude/Codex plugins to a specific release by
combining `--version <tag>` with `--local-marketplace`, which registers exactly
that snapshot.

Machines installed before this model shipped carry a directory-sourced
registration and are frozen at their install-day version. Two cures, either one
is enough:

```bash
# re-run the one-liner: it detects the Directory source and re-registers it
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v1/scripts/install.sh | bash

# or repoint by hand
claude plugin marketplace remove red-skills
claude plugin marketplace add reddb-io/red-skills
```

To check a machine without changing it, `/red-doctor` reports the registered
source per host CLI and flags a Directory-sourced `red-skills` marketplace;
`/red-doctor --fix` repoints it after confirmation.

## Manual: Claude Code

```text
/plugin marketplace add reddb-io/red-skills
/plugin install dev@red-skills
/plugin install memory@red-skills
/plugin install brain@red-skills
```

Common `dev` commands become native slash commands:

```text
/red-setup
/triage
/afk --once
/go "one concrete demand"
/dashboard
```

Memory and Brain skills are plugin skills:

```text
$init
$store Decision: cache TTL is 300 seconds because upstream rate limits.
$recall cache TTL
$capture Remember this project decision...
$think What do we know about the billing migration?
```

Upgrade or remove:

```text
/plugin marketplace update red-skills
/plugin uninstall brain@red-skills
/plugin uninstall memory@red-skills
/plugin uninstall dev@red-skills
/plugin marketplace remove red-skills
```

## Manual: Codex CLI

```bash
codex plugin marketplace add reddb-io/red-skills
codex plugin marketplace upgrade red-skills
codex plugin add dev@red-skills
codex plugin add memory@red-skills
codex plugin add brain@red-skills
codex plugin marketplace remove red-skills
```

Codex invokes skills with `$<skill>`. Some clients expose plugin skills with
the plugin namespace; use that form when it appears in the skills list:

```text
$dev:red-setup
$dev:triage
$dev:afk --once
$dev:retake #123
$memory:init
$memory:recall cache TTL
$brain:capture Save this project note...
```

Codex currently supports built-in footer items through `tui.status_line`, not a
command-backed statusline. Use `$dev:afk monitor` when the client exposes
namespace-qualified skills, or `$afk monitor` when it exposes unqualified skill
names.

## Manual: Gemini CLI

Gemini CLI support requires installing from a local path or using the native
marketplace setup script when released. A local-path install is a snapshot: it
sees new releases only when you re-run it against an updated checkout. For local
setups, run from a checkout:

```bash
gemini plugin install ./plugins/dev
gemini plugin install ./plugins/memory
gemini plugin install ./plugins/brain
```

Or use the global marketplace flow, which registers the GitHub source and so
picks up every future release (see
[How Updates Reach a Machine](#how-updates-reach-a-machine)):

```bash
gemini plugin marketplace add reddb-io/red-skills
gemini plugin install dev@red-skills
gemini plugin install memory@red-skills
gemini plugin install brain@red-skills
```

Gemini invokes skills natively and requires loading skills ahead of tool calls (see `activate_skill`). Common commands:

```text
/red-setup
/triage
/afk --once
```

## Codex Manifest Maintenance

Codex manifests are generated artifacts. Do not hand-edit
`.agents/plugins/marketplace.json` or `plugins/*/.codex-plugin/plugin.json`.
Change the Claude-side marketplace/plugin manifests or plugin tree, then run:

```bash
pnpm codex:manifests
pnpm gemini:manifests
```

CI runs `pnpm codex:manifests:check` and `pnpm gemini:manifests:check` and fails when committed Codex or Gemini manifests
drift from the generator output.

## Pi Manifest Maintenance

Pi ships two generated artifacts that must stay in sync with the Claude-side
plugin tree:

- `plugins/<name>/package.json` — the local-path install surface (ADR 0075-era
  shape; consumed by `pi install <path>`).
- `packaging/pi/<name>/package.json` plus `packaging/pi/<name>/skills/` — the
  npm publish surface (ADR 0110; consumed by `pi install npm:@reddb-io/red-skills-<plugin>`).

Both are generated. Do not hand-edit either. Change the Claude-side plugin
manifest or the plugin tree, then run:

```bash
pnpm pi:manifests        # regenerates plugins/<name>/package.json
pnpm pi:packages:build   # stages packaging/pi/<name>/ from plugins/<name>/
```

CI runs both `pnpm pi:manifests:check` and `pnpm pi:packages:check` and fails
when either committed artifact drifts. The release pipeline runs the build
step before publishing, so a manual regeneration is only required when working
on Pi support itself.

## Manual: OpenCode

OpenCode support is generated from the same plugin source tree as Claude Code
and Codex. The installer writes skills, plugin modules, MCP config, provider
config, and TUI attention config for OpenCode. The universal installer is
preferred for normal user-scoped installs; use the direct script when developing
or when installing/removing a checkout in a specific project.

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills

# user-scoped install into ~/.config/opencode
scripts/install-opencode.sh --global

# user-scoped uninstall from ~/.config/opencode
scripts/install-opencode.sh --uninstall --global

# project-local install into the current repo
scripts/install-opencode.sh

# project-local uninstall from the current repo
scripts/install-opencode.sh --uninstall

# inspect without writing
scripts/install-opencode.sh /path/to/project --dry-run
```

Then run OpenCode in any configured project:

```bash
opencode .
```

Use `/connect` inside OpenCode or export one of `OPENAI_API_KEY`,
`MINIMAX_API_KEY`, or `OPENROUTER_API_KEY`. Generated config never stores auth
secrets. Details live in [apps/opencode-host](../apps/opencode-host/README.md).

## Manual: Pi

RedSkills ships one Pi package per published plugin on npm under the
`@reddb-io` scope. The packages are generated from the same Claude-side
manifests the other hosts consume, so the same skill buckets (`engineering`,
`knowledge`, `productivity`, `misc`, `core`) Claude Code and Codex already
expose are what Pi discovers.

The natural install is the same one-liner Pi documents for every npm package:

```bash
pi install npm:@reddb-io/red-skills-dev
pi install npm:@reddb-io/red-skills-memory
pi install npm:@reddb-io/red-skills-brain
# (optional) maintainer-only — gated by plugins.internal.enabled: true
pi install npm:@reddb-io/red-skills-internal
```

Updates follow the rest of the release train: `pi update --all` resolves the
latest matching version from the npm registry and the new skills reload on the
next session start.

For repo-scoped installs that ship with the project (so teammates pick up the
same RedSkills surface on first launch), use the bundled installer:

```bash
# user-scoped install into ~/.pi/agent/settings.json (npm: surface)
scripts/install-pi.sh

# project-scoped install into <repo>/.pi/settings.json
scripts/install-pi.sh --project /path/to/your-project

# pin a specific published version (e.g. before a tagged release)
RED_SKILLS_PI_VERSION=3.1.2 scripts/install-pi.sh

# dev path: install from a local checkout (in-repo workflow)
scripts/install-pi.sh --source-dir /path/to/red-skills-checkout

# user-scoped uninstall
scripts/install-pi.sh --uninstall

# dry-run + inspect
scripts/install-pi.sh --project . --dry-run
```

`scripts/install-pi.sh` writes `~/.pi/agent/redskills-install-manifest.json` (or
`<project>/.pi/redskills-install-manifest.json` for `--project`) recording each
`npm:` spec it registered, so a subsequent `--uninstall` cleanly tears down
exactly that surface. The `--source-dir` form records local-path specs in the
same manifest under a separate `source` discriminator.

Known limitations versus the other hosts:

- Pi does not run lifecycle hooks, so the Codex/Claude `SessionStart`/`Stop`
  hooks (the rsp interception bridge, red-fetch, command-guard, branch-lock,
  statusline wiring) are not active in Pi. Skills that depend on those hooks
  lose telemetry but stay navigable; agent runners and `navigator` MCP servers
  are unaffected.
- Two plugins (`memory` and `brain`) ship a skill with the same `name: view`.
  Pi warns on duplicate skill names and keeps the first one registered, so
  install `memory` or `brain` last depending on which `view` you want as the
  primary entry point.
- Pi does not advertise the plugin display metadata Codex uses; the npm
  `description` field is the only user-visible summary in `pi list`.
- The `internal` package is gated by `plugins.internal.enabled: true`
  (ADR 0067) the same way the Claude and Codex marketplaces expose it. The npm
  package is public; the gate is what keeps it inactive in non-maintainer
  repos.

After installing, restart any open Pi session so the new skills reload.
`scripts/install-pi.sh --help` documents the user/project scope split, the
`--source-dir` dev path, and the `--uninstall` flow.

## No Marketplace

Older agents, local hacking, or Gemini-style skill loading can install from a
checkout:

```bash
npx skills@latest add reddb-io/red-skills
```

For local symlinks:

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills
./scripts/link-skills.sh
```

Marketplace installs auto-update when the marketplace is registered from the
GitHub source ([How Updates Reach a Machine](#how-updates-reach-a-machine)).
`npx skills` and manual symlinks do not.

## Verify Runners

Before a release, or after upgrading Claude Code/Codex, run:

```bash
./scripts/doctor-runners.sh
```

It checks plugin metadata, shell syntax, runner flags used by `/afk`, Codex
marketplace registration in a temporary home, and manual skill-link installs.
