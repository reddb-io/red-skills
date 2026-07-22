---
"@reddb-io/dev": minor
---

Releases now flow through a changesets Version Packages PR and a tag-triggered
publish workflow (ADR 0121). The version bump lands as a normal reviewed PR
instead of being pushed straight to protected `main`, which retires the
`RED_RELEASE_TOKEN` admin bypass, the GH006 side-branch fallback,
`release-push-bump.sh`, and the conventional-commit bump decider.
