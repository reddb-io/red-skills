---
"@reddb-io/dev": patch
---

The release reaches the registry again.

The Release standard cutover moved the version half of releasing into an engine
and, in the same commit, deleted the workflow that published the other half.
Nothing went red, because the only thing that read the publish workflow was the
publish workflow. The first release after the cutover produced a tag, a Release,
and no artifacts at all — no bundles, no `.vsix`, no npm.

- **The artifact publisher is back, on the tag the engine produces.** It builds
  every bundle, uploads the assets, publishes the npm and Pi packages, smoke-tests
  the install, and moves the `vX` ref. Restoring it unchanged would have published
  nothing: the assets only ever uploaded on the branch that *creates* the Release,
  and the engine creates it now, so that branch was unreachable. **One Release, one
  owner** — the job waits for the Release its tag's engine run published, then
  uploads onto it, and holds no `gh release create` at all. Two creators would race
  over one object, and the engine re-reads the body it wrote.
- **The contracts guarding that workflow run in the PR gate**, not only inside the
  publish they guard — which is to say, no longer only after the last chance to fix
  anything.
- **Assets upload to the host the Release names.** Asset upload is the one Release
  call GitHub does not serve from the API host. The route was spelled relative to
  the client's base URL, so it resolved to a path that exists nowhere and came back
  as a bare 404. The Release carries `upload_url`; the uploader reads it, which is
  also what makes this correct on Enterprise. The fixture is where this hid — it
  served the upload from the API origin, so no test could observe that the real
  host does not.
- **The release commit is authored by an account GitHub can resolve.** GitHub
  attributes a commit by author email, and the engine used an address belonging to
  nobody — so a repository whose approval policy is `first_time_contributors` read
  every Version PR as exactly that and held its checks at `action_required`. The
  autonomous train ended by asking a human to click Approve. The name stays the
  loop-breaker the generated workflow reads; two roles, two fields.
- **The release job carries the repository's toolchain.** The `sync_command` is
  declared by the operator and may reach any tool the repo has; the generated job
  installed only Node, so the first sync died on `pnpm: not found`.
