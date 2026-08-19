---
"@reddb-io/shared": patch
"@reddb-io/dev": patch
---
The RedSkills root on a machine is `~/.red/skills`, inside the `.red` namespace
with the rest of what red-dev keeps for a person. The launcher's
`RED_SKILLS_INSTALL_ROOT` default, the standalone installer's `--install-root`
and `--uninstall --purge`, and the docs all spell the new root; nothing in the
repository looks for or recreates `~/.red-skills` any more. red-dev moves an
existing machine across on its next run.
