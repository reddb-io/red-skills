---
"@reddb-io/red-skills": patch
---

The standalone installer hands ownership to mise and red-dev instead of acquiring RedSkills itself: it checks the platform, installs the pinned `red-dev@1` entry point through mise when it is missing, proves that entry point answers, and runs `red-dev install`. It no longer materialises an `~/.red-skills/versions/<tag>` tree, registers a marketplace of its own, or heals a Directory-sourced registration back to GitHub — that heal tore out the wiring red-dev writes. `/red-doctor` check 26 inverts with it: a directory source is the owner's and is reported clean, a GitHub source is the retired installer's leftover, and the doctor no longer repoints either. `--local-dev --source-dir <checkout>` remains as an explicit development escape hatch that says it is not a production installation.
