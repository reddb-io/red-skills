# Setup RedSkills Reference

# Setup RedSkills

**Scaffold the per-repo configuration that the engineering skills assume — this skill is the only thing authorized to create `.red/`.** NEVER create `.red/` outside this skill — plugins stay fully inert in any directory whose `.red/config.yaml` is missing or lacks an explicit `plugins.<name>.enabled: true`.

Scaffold includes:

- **Plugin activation** — the per-directory gate (ADR 0067): which RedSkills plugins (`dev`, `memory`, `brain`) are allowed to run here.
- **Issue tracker** — GitHub Issues (the only supported option, reddb.io policy)
- **Triage labels** — the strings used for the canonical triage roles and label families
- **Domain docs** — where `.red/CONTEXT.md` and ADRs live, and the consumer rules for reading them
- **Workflows** — GitHub Actions shipped by RedSkills (installed under the `rs-*` prefix), e.g. auto-label fresh issues with `needs-triage` so nothing slips past `/triage` and `/afk`
- **Token efficiency** — provision the repo-owned `rsp` opt-in (`rsp.enabled: true`) so supported noisy commands can use wrapper summaries, reversible elision handles, and hook rewrites without a third-party proxy
- **Runtime launcher** — optionally install a host-level `red-skills-dev` shim so Claude Code, Codex, and opencode can invoke the same dev runtime without relying on CLI-specific plugin-root env vars
- **Required host binaries** — install pinned `tq` (`TQ_VERSION=v0.13.0`) through the toon repo installer and record `host_binaries.tq.version` so `/red-doctor` can enforce the no-jq-fallback TOON/TOONL contract
- **Execution daemon** — provision the host-scoped `redskilled` daemon (ADR 0130) by running `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision`, and optionally install the supervising user unit. The daemon's home `~/.red/redskilled/` is owned and created by `redskilled` itself, not by this skill
- **Command guards** — configure the repo-owned `.red/config.yaml` policy that the globally-installed Claude Code, Codex, and opencode hook proxies enforce
- **Development workflow** — teach agents the `.red/tmp` worktree rules, preserve the primary checkout for the human, and route one-off concrete work through `/go` (ADR 0081)

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Explore Checklist

### Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `.red/CONTEXT.md` and `.red/CONTEXT-MAP.md` at the repo root
- `.red/adr/` — the single root ADR sequence (there are no nested `.red/` subtrees)
- `.red/agents/` — does this skill's prior output already exist?
- `.red/config.yaml` — does it exist? Which plugins are already enabled (`plugins.<name>.enabled: true`)? Is the canonical `plugins.dev.lock.primary-branch` flag already set? Is `command_guard` already configured, and under which scopes (`global`, `main`, `worktree`, or legacy `deny`)?
- Worktree dependency setup — inspect root lockfiles, `package.json.packageManager`, Corepack metadata, and the root `prepare` plus dependencies/devDependencies for `lefthook` or `husky`; compare those facts with `plugins.dev.afk.setup` when already declared
- `tq --version` and `.red/config.yaml` `host_binaries.tq.version` — is the required host binary present and pinned to `0.13.0`?
- `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled provision --check` — is the daemon provisioned on this host, and if not, which of `home` / `daemon-entry` / `reach` is missing? (Read-only: it creates nothing and starts nothing.)
- `AGENTS.md` and `CLAUDE.md` — does either already have a `## Development workflow` section?
