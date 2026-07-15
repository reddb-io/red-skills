# End-of-session doc-landing finalizer

When a doc-writing session ends (the user stops or every reachable branch is resolved), run one end-of-session doc-landing finalizer before exiting:

1. Detect modified or untracked docs in the primary checkout across the domain glossary (`.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`) and ADRs (`.red/adr/**`). A session with no doc changes skips the finalizer silently.
2. If docs changed, do this first: Announce the file list and ADR numbers to the user, and accept a decline. A decline leaves the docs unlanded; the cascade gate remains the enforcement point.
3. If accepted, land the docs through the standard docs-worktree lane: create one worktree under `.red/tmp/worktrees/docs/<slug>` from a freshly fetched `origin/{base}` (base resolved lock > pin > main), using the name pattern `docs-<YYYYMMDD>-<slug>` for the worktree slug, copy only the dirty doc files into that worktree, commit them as a `docs:`-typed change, push the branch, open a PR, merge it, and rely on the existing post-landing fast-forward to bring the local base up.
4. Restate these safety prohibitions before landing: never commit in the primary checkout, never switch its branch, never stash, never reset.
5. Land at most one batch PR per session.
