# Setup RedSkills Reference

# Setup RedSkills

**Scaffold the per-repo configuration that the engineering skills assume — this skill is the only thing authorized to create `.red/`.** NEVER create `.red/` outside this skill — plugins stay fully inert in any directory whose `.red/config.yaml` is missing or lacks an explicit `plugins.<name>.enabled: true`.

Scaffold includes:

- **Plugin activation** — the per-directory gate (ADR 0067): which RedSkills plugins (`dev`, `memory`, `brain`) are allowed to run here.
- **Issue tracker** — GitHub Issues (the only supported option, reddb.io policy)
- **Triage labels** — the strings used for the canonical triage roles and label families
- **Domain docs** — where `.red/CONTEXT.md` and ADRs live, and the consumer rules for reading them
- **Workflows** — GitHub Actions shipped by RedSkills (installed under the `rs-*` prefix), e.g. auto-label fresh issues with `needs-triage` so nothing slips past `/triage` and `/afk`
- **Token efficiency** — strongly recommend installing [RTK](https://github.com/rtk-ai/rtk) to cut 60–90% of dev-operation tokens via a transparent CLI proxy
- **Runtime launcher** — optionally install a host-level `red-skills-dev` shim so Claude Code, Codex, and opencode can invoke the same dev runtime without relying on CLI-specific plugin-root env vars
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
- `AGENTS.md` and `CLAUDE.md` — does either already have a `## Development workflow` section?
