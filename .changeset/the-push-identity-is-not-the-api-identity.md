---
"@reddb-io/dev": patch
---

Give every pushing workflow a push identity that is not the bot

A workflow's PUSH identity is not its API identity, and only the push is what
GitHub's anti-recursion guard watches. `actions/checkout` persists whatever token
it is given as the git credential and defaults to `GITHUB_TOKEN` — so a workflow
can hold a PAT, spend it on every API call, open its PR as the PAT identity, and
still push as `github-actions[bot]`, leaving every `pull_request` run on that
branch parked in `action_required` with every check green.

The earlier repair moved the PAT to the changesets action's `github-token` input.
The PR author changed to the PAT identity, so the fix looked complete, while the
commit stayed bot-authored and the release train kept stopping — once per merge
to main, which on a busy day is one manual approval per merge.

`red-release.yml`, `red-toon-watch.yml` and `red-publish.yml` now check out with
`secrets.RELEASE_PAT`. A guard (`apps/dev/tests/push-identity-guard.test.ts`)
fails any workflow that pushes while checking out as the bot — an ABSENT `token:`
fails the same way an explicit one does, because the default is the bot and that
silence is how this shipped twice.
