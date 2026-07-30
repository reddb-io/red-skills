---
name: red-setup
description: >-
  The one authorized creator of a repo's `.red/` directory and the only way to
  enable RedSkills plugins (dev, memory, brain) in a project (ADR 0067).
  RedSkills hooks are installed globally on every agent but stay fully inert in
  any directory without a `.red/config.yaml` whose
  `plugins.<name>.enabled: true` opts that plugin in. This skill prompts which
  plugins to enable, creates `.red/`, writes the activation flags, and sets up
  `## Agent skills`/`## Development workflow` blocks in AGENTS.md/CLAUDE.md plus
  `.red/agents/`. Run to turn RedSkills on in a repo, to enable/disable a
  plugin, before first use of `to-tickets`, `to-spec`, `triage`, `diagnose`,
  `tdd`, `improve-codebase-architecture`, `zoom-out`, or `/go`, or if those
  skills appear to be missing context.
disable-model-invocation: true
---

# Setup RedSkills

**Scaffold the per-repo configuration that the engineering skills assume — this skill is the only thing authorized to create `.red/`.** NEVER create `.red/` outside this skill — plugins stay fully inert in any directory whose `.red/config.yaml` is missing or lacks an explicit `plugins.<name>.enabled: true`.

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

<what-to-do>

## Hot Path

1. **Explore first.** Inspect the repo state listed in [REFERENCE.md](./REFERENCE.md#explore-checklist); do not assume prior RedSkills setup is absent or current.
2. **Ask in sequence.** Walk the user through one setup section at a time. Keep the plugin-activation gate first, then continue through issue tracker, triage labels, domain docs, workflows, token efficiency, runtime launcher, required host binaries, execution daemon, statusline, config template, command guards, development workflow, and hook scripts. Use the exact section copy and choices in [INTERVIEW.md](./INTERVIEW.md).
3. **Confirm before writing.** Show the draft agent-skills block, generated agent docs, development-workflow changes, and any accepted command-guard policy before editing. See [WRITE-CONTRACT.md](./WRITE-CONTRACT.md#confirm-and-edit).
4. **Write under the no-clobber contract.** Never overwrite, rewrite, or reorder existing user-owned content except for the explicit surgical merges named in [WRITE-CONTRACT.md](./WRITE-CONTRACT.md#write). Use the existing-file selection rules, seed docs, workflow copy rules, plugin-activation merge, development-workflow injector, statusline wiring, and hook-script registration exactly as documented there.
5. **Sweep existing issues only after setup.** If open issues exist, group label backfill candidates and ask for one batch approval before editing labels. See [ISSUE-SWEEP.md](./ISSUE-SWEEP.md).
6. **Finish with the setup recap.** Tell the user which plugins are enabled here, remind them that other directories stay inert until setup runs there too, point memory/brain users at their next init step, and route one-off concrete work through `/go`, backlog work through `/afk`, and parked issues through `/retake`.

## Hard Rules

- **Only this skill may create `.red/`.** Creating `.red/` is authorized only by the plugin-activation decision; if the user enables no plugins, write nothing.
- **The daemon's home is the daemon's.** This skill's `.red/` authority is repository-scoped. `~/.red/redskilled/` is operator-scoped, owned by `redskilled` (ADR 0130 Amendment 1), and provisioned by running `redskilled provision` — never by creating the directory here.
- **Global hooks are inert by default.** A plugin block alone is not enough: each enabled plugin must have `plugins.<name>.enabled: true` in `.red/config.yaml` (ADR 0067).
- **GitHub Issues only.** In reddb.io repos there is no local fallback and no supported alternate issue tracker. Stop if the repo has no GitHub remote.
- **No clobbering.** Existing files are project state. Skip existing targets unless the referenced write contract explicitly names a surgical exception.
- **Do not add generated setup files for the user.** In particular, do not `git add` `.red/config.yaml`, `.red/.gitignore`, or hook files written by this setup.
- **Workflow install is opt-in by lane.** Install only the workflows the user picked; standalone copy-installables keep their `red-*` filename, while reusable callers use `rs-*`.
- **Command guards are offer-only.** The built-in dev worktree invariant comes from `plugins.dev.enabled: true`; do not write example `command_guard` rules unless the user explicitly accepts them.
- **ask-red maintenance rule.** Skill add, rename, removal, or flow changes require re-checking `../ask-red/SKILL.md` and updating its Coverage Inventory/routes. A progressive-disclosure-only extraction of this skill is not such a change; no router update is expected after re-checking.

</what-to-do>

<supporting-info>

## Reference Map

- [REFERENCE.md](./REFERENCE.md) — setup scope, scaffold list, and exploration checklist.
- [INTERVIEW.md](./INTERVIEW.md) — the full section-by-section user interview, including plugin activation, workflows, token efficiency, runtime launcher, statusline, config template, command guards, development workflow, and hook-script offers.
- [WRITE-CONTRACT.md](./WRITE-CONTRACT.md) — confirmation draft requirements, no-clobber rules, file-selection rules, seed-doc writes, workflow installation, config merges, statusline wiring, hook writes, and final recap text.
- [ISSUE-SWEEP.md](./ISSUE-SWEEP.md) — open-issue label backfill mechanics.
- Existing seed/reference files: [issue-tracker-github.md](./issue-tracker-github.md), [triage-labels.md](./triage-labels.md), [domain.md](./domain.md), [config-template.yaml](./config-template.yaml), [WORKFLOWS.md](./WORKFLOWS.md), and [scripts/install-runtime-shim.sh](./scripts/install-runtime-shim.sh).

</supporting-info>
