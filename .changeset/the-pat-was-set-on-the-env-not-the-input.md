---
"@reddb-io/red-skills": patch
---

The release train's PAT was set on the environment and read from the input, so it was present, valid and unused. `changesets/action`'s `github-token` input defaults to `${{ github.token }}`; the workflow set only `env.GITHUB_TOKEN`, and the step logged both `github-token: ***` and `GITHUB_TOKEN: ***` before authenticating with the first and pushing as `github-actions[bot]`. GitHub's anti-recursion guard then parked every resulting `pull_request` run in `action_required` — fifteen of them across three commits on 2026-08-03 — so the Version Packages PR sat `BLOCKED` on required checks that could never start, and publishing stopped for over half an hour while every check that had run was green. The token now goes to the input; the env var stays for the `changeset` subprocesses that read the environment rather than the input.
