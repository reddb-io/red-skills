---
"@reddb-io/red-skills": patch
---

An operator's installed plugin now counts as evidence in the published-version ladder (#2924). The ladder ranked `registry` → `recorded` → `bundle-cache`, and the versions sitting in `~/.claude/plugins/cache/red-skills/dev/` — written by the operator's own upgrade, readable with no network call and no registry quota — were read by nothing. So an upgrade to 3.0.4 produced no observable change: the answer fell through to a bundle cache still holding 3.0.3, and every surface reported `stale: true, reason: cache-only` against a version the operator had already moved past.

**A cached bundle is a byproduct; an installed plugin is a decision.** The cache proves this host once ran a version; the install proves somebody chose it. The new `installed-plugin` rung ranks above `bundle-cache` and below both a live `registry` read and a fresh `recorded` one, and it is honest about what it proves — `reason: installed-only`, always `stale`, because an install says nothing about whether the registry has moved past it. It also stays below an aged-out registry answer that already proved a *newer* publication: adding intent must never walk the reported version backwards.

`unresolved` stays unresolved. With no evidence at all the answer is still `version: null, published_unknown: 1` — substituting a local value for an unknown is the #2809 defect, and the installed plugin is admitted precisely because it is the host's fact, identical for every asker, not the asker's own version reflected back.
