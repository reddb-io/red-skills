# Setup RedSkills Write Contract

## Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `.red/agents/issue-tracker.md`, `.red/agents/triage-labels.md`, `.red/agents/domain.md`
- The Section H development-workflow changes: `plugins.dev.lock.primary-branch: true` plus the canonical `## Development workflow` block for `AGENTS.md` and `CLAUDE.md`
- The Section E2 required-host-binary record: `host_binaries.tq.version: 0.3.0`
- The Section E3 daemon provisioning: the `redskilled provision` run, and — only if the user asked for it — the text of the optional `redskilled.service` user unit
- The Section G1 command-guard changes if the user accepted them: the exact `command_guard` block or scoped entries that will be written to `.red/config.yaml`

Let them edit before writing.

## Write

**No-clobber rule (governs every write below).** Never overwrite, rewrite, or reorder content in a file this skill did not just create: if a target already exists, skip it, log a one-line notice, and move on — no second ask, and never `git add` on the user's behalf. Two surgical merges are the *only* exceptions, flagged at the steps that own them: updating `plugins.<name>.enabled` flags in an existing `.red/config.yaml`, and appending a missing `tmp/`, `state/`, or `researches/` line to an existing `.red/.gitignore`. (Copied workflow YAML is the one "ask, don't silently skip" case — diff and ask first.)

**Config-key spelling rule.** Write `.red/config.yaml` keys only in the spellings that appear in [config-template.yaml](./config-template.yaml). Folded accessor names such as root-level `dev.*` or bare `afk.*` are display/reader vocabulary only; never write them as YAML keys because folding readers may honor them while exact-key readers ignore them, creating a split-brain config.

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `.red/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `.red/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `.red/agents/domain.md`.
```

Then write the three docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker (the only option)
- [triage-labels.md](./triage-labels.md) — label mapping
- [domain.md](./domain.md) — domain doc consumer rules + layout

If the user accepted Section D, copy each standalone `red-*.yml` template the user picked from this skill folder's `workflows/` into `.github/workflows/` of the consumer repo **verbatim — keep the `red-*` filename, do not rename** (e.g. `workflows/red-issues-needs-triage.yml` → `.github/workflows/red-issues-needs-triage.yml`): standalone copy-installables keep their `red-*` prefix, only reusable **callers** get renamed to `rs-*` (AFK lane below). Don't overwrite an existing file — diff and ask first. Then ensure both `needs-triage` and `runner-error` labels exist via `gh label create` if missing (`gh label create runner-error --color B60205 --description "AFK supervisor circuit-tripped; runner was misconfigured"`).

**If the user opted into the autonomous AFK execution lane** (Section D, default no), additionally:

1. Copy [`../afk/examples/rs-afk-attempt.yml`](../afk/examples/rs-afk-attempt.yml) to `.github/workflows/rs-afk-attempt.yml` in the consumer repo (installed name is `rs-*`; the `uses:` ref inside still points at the `reusable-afk-attempt.yml` reusable — leave it). Don't overwrite an existing file — diff and ask first.
2. Edit `allowlist_authors` and `allowlist_label_actors` to the maintainer login(s) the user named (the trust gate; keep it short on public repos).
3. Apply the trigger choice from Section D: keep `workflow_dispatch` for a manual caller, the `issues: labeled` auto-trigger, or both. (The reusable's own `if:` gate auto-triggers on `ready-for-agent` even when only the dispatch caller exists.)
4. Set the `model:` input to the slug the user picked (e.g. `minimax/MiniMax-M3`), or leave it empty to fall back to the repo's `.red/config.yaml` model config.
5. Print the secret-setup guidance — the lane needs one OpenCode auth key; do **not** set it for them (secrets are the user's to provision): `gh secret set MINIMAX_API_KEY --repo OWNER/REPO` (or `OPENAI_API_KEY` / `OPENROUTER_API_KEY`; first set wins). **Public-repo gotcha:** if the repo is public, an *org* secret resolves empty unless its "Repository access" includes this repo — prefer a repo secret, or widen the org secret's access. Point them at [`../afk/actions-lane.md`](../afk/actions-lane.md#configuring-secrets-per-provider) for the per-provider table + auth precedence + the `model` slug.
6. Note that the lane will not fire until both a secret is set (and reaching the repo) and an issue carries `ready-for-agent` from an allowlisted actor.

Scaffold `.red/config.yaml` (Section G), writing the Section A0 activation flags
and the `rsp` opt-in block:

1. If `.red/config.yaml` already exists at the repo root, apply the **plugin-flags exception** to the no-clobber rule: surgically add/update the `plugins.<name>.enabled` flags to match the Section A0 choice (add a `plugins:` block or `plugins.<name>:` child if missing; set `enabled: true` for enabled plugins; remove the flag or set `false` for ones the user turned off), and surgically add/update the top-level `rsp:` block to `enabled: true`, `ttlDays: 7`, `ephemeralTtlHours: 6`, and `byteBudget: 67108864`; touch nothing else, and log `.red/config.yaml present - merged plugin activation flags and rsp defaults, left the rest as-is`.
2. Otherwise, ensure `.red/` exists (this section is the authorized creator) and copy [config-template.yaml](./config-template.yaml) to `.red/config.yaml`, then surgically edit only the template-provided values that Section A0 selected. Do not compose the `plugins:` block from memory: start from the shipped template, preserve its key nesting, and only uncomment/flip the relevant `plugins.<name>.enabled` flags (the template ships with `plugins.dev.enabled: true` as the baseline and `memory`/`brain` commented — uncomment/flip per the choice). The `rsp` block ships enabled with default retention because the hook remains strictly per-repo opt-in: absent block or any value other than `enabled: true` is inert. The rest of the template is a fully-commented snapshot of every v1 knob the AFK config loader (`apps/dev/src/core/config.ts`) reads, so it stays a no-op until the user uncomments a line — including the commented `command_guard` and `afk.backpressure` blocks.
3. **Provision the rsp elision store.** Run `rsp setup` from the repo root. This is the supported provisioning command: it writes the `rsp:` config block and points rsp at the shared repo-local RedDB store `.red/state/red-skills.rdb` (per ADR 0098). Elision records use the `rsp_elisions_v1` KV collection with storage-class accounting and a physical byte cap; legacy JSON files are only a fallback/migration path, not the normal setup target. `rsp setup` performs no memory-graph migration and does not create, move, or repoint `.red/memory/graph.rdb` or `plugins.memory.storePath`; memory and brain keep using RedDB through their own provisioning path.
4. **Self-ignore `.red/`'s local state.** Whenever `.red/` exists (fresh scaffold or pre-existing), make the directory protect itself so `.red/tmp`, `.red/state`, and `.red/researches` never get committed regardless of the repo-root `.gitignore`. Write `.red/.gitignore` if it is **missing** with exactly:

   ```gitignore
   # Generated by /red-setup — local AFK/runtime state, never committed.
   tmp/
   state/
   researches/
   ```

   If `.red/.gitignore` already **exists**, apply the **gitignore-append exception**: append whichever of the three patterns (`tmp/`, `state/`, `researches/`) is missing, and never rewrite or reorder existing lines. Keep tracked `.red` content (`config.yaml`, `contexts/`, `adr/`, `agents/`, `contracts/`, `hooks/`) committable — only local state and generated research reports are ignored. Do **not** `git add` `.red/.gitignore` (step 5 — the user controls when `.red/` lands in git).
5. **Backpressure pre-fill offer (only on a fresh scaffold).** Read the repo-root (or primary package) `package.json`; if it declares `test` and/or `lint` scripts, surface them and ask whether to pre-fill `afk.backpressure` with the matching `npm run <script>` (or `pnpm run <script>`) lines, uncommented. On explicit yes, replace the commented `backpressure:` placeholder with the confirmed list; otherwise leave it commented. Skip silently when no such scripts exist. This step never runs when `.red/config.yaml` already existed (step 1 wins).
6. **Command guard write (only when Section G1 was explicitly accepted).** Update `.red/config.yaml` with the confirmed `command_guard` policy. If the file is fresh, replace the commented placeholder with the confirmed block. If the file already existed, merge only the accepted `command_guard.global`, `command_guard.main`, and/or `command_guard.worktree` entries, appending without duplicates and preserving unrelated content. If a legacy `command_guard.deny` block exists, leave it intact unless the user explicitly approved migrating it to `global`.
7. **Mandatory post-write config check.** Load the just-written `.red/config.yaml` through the real dev config loader before setup can finish. From a source checkout, run `pnpm --filter @reddb-io/dev dev red-doctor` from the target repo root; from an installed plugin, run `red-skills-dev red-doctor`. If the loader prints an off-contract-spelling warning such as root-level `dev.*` or bare `afk.*`, treat the check as red: fix `.red/config.yaml` back to the template spelling, re-run the same command, and only continue when the warning is gone.
8. Do **not** `git add` or commit `.red/config.yaml` or `.red/.gitignore` — the user controls when they land in git.

Install and record required host binaries (Section E2):

1. Run the pinned toon installer exactly as documented:

   ```bash
   TQ_VERSION=v0.3.0 curl -fsSL https://raw.githubusercontent.com/reddb-io/toon/v0.3.0/install.sh | sh
   ```

2. Verify `tq --version` reports `0.3.0`. If it does not, stop and report the mismatch; do not offer a jq fallback.
3. Ensure `.red/config.yaml` records the pin:

   ```yaml
   host_binaries:
     tq:
       version: 0.3.0
   ```

   If `.red/config.yaml` already exists, merge only that `host_binaries.tq.version` entry and preserve unrelated content.

For Section E3, provision the execution daemon:

1. Run `redskilled provision`. It creates the host-scoped home, starts the daemon, and prints the audit. **Never `mkdir ~/.red/redskilled/` here** — the home belongs to `redskilled` (ADR 0130 Amendment 1) and this skill's `.red/` authority is repository-scoped. Re-running is a no-op, so run it on every pass.
2. If the verdict is not `ok`, print the per-check fix the command already named and stop rather than improvising one. A `daemon-entry` finding is a missing published bundle, cured by warming the bundle for this host and re-running — never by pointing the daemon at a caller's own entry.
3. Only if the user accepted the optional supervising unit, run `redskilled provision --install-unit` and then tell them the `systemctl --user` commands. The installer writes the unit only when absent; per the no-clobber rule, an existing `redskilled.service` is left exactly as the operator has it.
4. Do not write anything about the daemon into `.red/config.yaml` — the daemon reads no repository config (ADR 0130 rule 3).

If the user accepted Section H, activate the development workflow:

1. Invoke the shared injector rather than hand-editing the rules block. From a source checkout, run `pnpm --filter @reddb-io/dev dev inject-development-workflow --root <repo-root>`. From an installed plugin, run the bundled AFK entrypoint with `inject-development-workflow --root <repo-root>` (for example, `node ../afk/bin/afk.mjs inject-development-workflow --root <repo-root>` from this skill folder). The command writes both `AGENTS.md` and `CLAUDE.md`, creates `.red/config.yaml` if still missing, and sets `plugins.dev.lock.primary-branch: true`.
2. If the command is unavailable, make the same changes manually: add or update the canonical `plugins:` → `dev:` → `lock:` block in `.red/config.yaml` so `primary-branch` is `true`, then upsert the canonical `## Development workflow` block in both `AGENTS.md` and `CLAUDE.md`. Never append a duplicate block; update the existing section in place. Leave any legacy top-level `dev.lock.*` keys untouched; `/red-doctor --fix` owns that migration.
3. In the recap, explicitly point the user at `/go` for one-off concrete work, and at a normal PR for a hand-worked worktree branch that is already committed and pushed.

If the user accepted Section F, wire the statusline:

1. Check the opt-out: if `.red/config.yaml` exists and contains an `afk:` block with `statusline: false`, log `afk.statusline: false in .red/config.yaml — skipping statusline wiring` and skip the rest of this step.
2. Check for an existing `statusLine` key in `.claude/settings.json`. If one is present, log `statusLine already configured in .claude/settings.json — leaving as-is` and skip the rest of this step.
3. Otherwise, ensure `.claude/` exists and write/merge the `statusLine` block above into `.claude/settings.json`. Use `jq` for the merge when the file already has unrelated keys; create a fresh file containing only `statusLine` when missing.

If the user confirmed any hook scripts from Section I:

1. For each confirmed suggestion, ensure `.red/hooks/<point>/` exists (create the directory; `.red/` is already authorized by Section A0 — subdirectories under it are permitted).
2. Write `.red/hooks/<point>/<name>` with the script content. Per the no-clobber rule, if the file already exists, skip it silently — log `.red/hooks/<point>/<name> already exists — not overwriting` and move on.
3. Update `.red/config.yaml`: add the script path under the `afk.hooks.<point>:` list. Use the relative-to-root form `bash .red/hooks/<point>/<name>` as the command string. If the key already has entries, append without duplicating; if missing, add it. The `afk:` → `hooks:` → `<point>:` nesting matches the config-template structure.
4. Do **not** `git add` any of the written files or the updated config.

Script content for each signal type (all open with `#!/usr/bin/env bash` + `set -euo pipefail`):

- `red-run-tests.sh` (`pre_merge`): `<pm> run test`
- `red-typecheck.sh` (`pre_merge`): `<pm> run typecheck` (or `type-check` per the detected key)
- `red-lint.sh` (`pre_merge`): `<pm> run lint`
- `red-build.sh` (`pre_merge`): `<pm> run build`
- `red-e2e.sh` (`post_merge`): `<pm> run e2e` (or `test:e2e` per the detected key)
- `red-make-<target>.sh` (`pre_merge`): `make <target>`
- `red-cargo-test.sh` (`pre_merge`): `cargo test`
- `red-gradle-check.sh` (`pre_merge`): `./gradlew check`
- `red-lint-staged.sh` (`pre_merge`): `npx lint-staged`
- `red-pre-commit.sh` (`pre_merge`): `pre-commit run --all-files`
- `red-slack-notify.sh` (`post_merge`):

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  # Post-merge Slack notification. Set SLACK_WEBHOOK_URL before running /afk.
  [ -z "${SLACK_WEBHOOK_URL:-}" ] && exit 0
  curl -sf -X POST "$SLACK_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"AFK merged issue #${RED_AFK_ISSUE:-?} on ${RED_AFK_REPO:-repo}\"}"
  ```

## Done

Tell the user the setup is complete, which plugins are now enabled here (and that all other directories stay inert until they run this skill there too), and which engineering skills will now read from these files. If they enabled **memory** or **brain**, point them at the next step — `/memory:init` to pick a storage mode, or the brain setup — since enabling only authorizes the plugin to run; its own init configures it. Mention they can edit `.red/agents/*.md` directly later, and that one-off concrete work should be dispatched with `/go` (backlog via `/afk`, parked issues via `/retake`). Re-run this skill to enable or disable a plugin, switch issue trackers, or restart from scratch.
