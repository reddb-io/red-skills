---
"@reddb-io/dev": patch
---

Skill docs now teach the npx direct-run form (`npx -y -p @reddb-io/red-skills@<version>
red-skills-dev ...`) as the canonical invocation everywhere; a bare `red-skills-dev`
shim is demoted to a warm-cache optimization. Field installs without the shim
followed the old docs into command-not-found failures.
