# @reddb-io/dev

## 3.3.13

### Patch Changes

- @reddb-io/github@3.3.13
- @reddb-io/shared@3.3.13
- @reddb-io/build-info@3.3.13
- @reddb-io/red-castle@3.3.13
- @reddb-io/redskilled@3.3.13
- @reddb-io/redskilled-render@3.3.13

## 3.3.12

### Patch Changes

- @reddb-io/github@3.3.12
- @reddb-io/shared@3.3.12
- @reddb-io/build-info@3.3.12
- @reddb-io/red-castle@3.3.12
- @reddb-io/redskilled@3.3.12

## 3.3.11

### Patch Changes

- @reddb-io/github@3.3.11
- @reddb-io/shared@3.3.11
- @reddb-io/build-info@3.3.11
- @reddb-io/redskilled@0.1.0
- @reddb-io/red-castle@0.11.0

## 3.3.10

### Patch Changes

- @reddb-io/github@3.3.10
- @reddb-io/shared@3.3.10
- @reddb-io/build-info@3.3.10
- @reddb-io/redskilled@0.1.0
- @reddb-io/red-castle@0.11.0

## 3.3.9

### Patch Changes

- @reddb-io/shared@3.3.9
- @reddb-io/build-info@3.3.9
- @reddb-io/redskilled@0.1.0

## 3.3.8

### Patch Changes

- @reddb-io/shared@3.3.8
- @reddb-io/build-info@3.3.8
- @reddb-io/redskilled@0.1.0

## 3.3.7

### Patch Changes

- @reddb-io/shared@3.3.7
- @reddb-io/build-info@3.3.7
- @reddb-io/redskilled@0.1.0

## 3.3.6

### Patch Changes

- @reddb-io/shared@3.3.6
- @reddb-io/build-info@3.3.6
- @reddb-io/redskilled@0.1.0

## 3.3.5

### Patch Changes

- @reddb-io/shared@3.3.5
- @reddb-io/build-info@3.3.5
- @reddb-io/redskilled@0.1.0

## 3.3.4

### Patch Changes

- @reddb-io/shared@3.3.4
- @reddb-io/build-info@3.3.4
- @reddb-io/redskilled@0.1.0

## 3.3.3

### Patch Changes

- @reddb-io/shared@3.3.3
- @reddb-io/build-info@3.3.3
- @reddb-io/redskilled@0.1.0

## 3.3.2

### Patch Changes

- @reddb-io/shared@3.3.2
- @reddb-io/build-info@3.3.2
- @reddb-io/redskilled@0.1.0

## 3.3.1

### Patch Changes

- @reddb-io/shared@3.3.1
- @reddb-io/build-info@3.3.1
- @reddb-io/redskilled@0.1.0

## 3.3.0

### Patch Changes

- @reddb-io/shared@3.3.0
- @reddb-io/build-info@3.3.0
- @reddb-io/redskilled@0.1.0

## 3.2.0

### Patch Changes

- @reddb-io/shared@3.2.0
- @reddb-io/build-info@3.2.0
- @reddb-io/redskilled@0.1.0

## 3.1.2

### Patch Changes

- @reddb-io/shared@3.1.2
- @reddb-io/build-info@3.1.2
- @reddb-io/redskilled@0.1.0

## 3.1.1

### Patch Changes

- @reddb-io/shared@3.1.1
- @reddb-io/build-info@3.1.1
- @reddb-io/redskilled@0.1.0

## 3.1.0

### Patch Changes

- @reddb-io/shared@3.1.0
- @reddb-io/build-info@3.1.0
- @reddb-io/redskilled@0.1.0

## 3.0.4

### Patch Changes

- @reddb-io/shared@3.0.4
- @reddb-io/build-info@3.0.4
- @reddb-io/redskilled@0.1.0

## 3.0.3

### Patch Changes

- @reddb-io/shared@3.0.3
- @reddb-io/build-info@3.0.3
- @reddb-io/redskilled@0.1.0

## 3.0.2

### Patch Changes

- @reddb-io/shared@3.0.2
- @reddb-io/build-info@3.0.2
- @reddb-io/redskilled@0.1.0

## 3.0.1

### Patch Changes

- @reddb-io/shared@3.0.1
- @reddb-io/build-info@3.0.1
- @reddb-io/redskilled@0.1.0

## 3.0.0

### Patch Changes

- @reddb-io/shared@3.0.0
- @reddb-io/build-info@3.0.0
- @reddb-io/redskilled@0.1.0

## 2.88.1

### Patch Changes

- @reddb-io/shared@2.88.1
- @reddb-io/build-info@2.88.1
- @reddb-io/redskilled@0.1.0

## 2.88.0

### Minor Changes

- 98eda6a: First slices of the `redskilled` host-scoped execution daemon (Spec #2772, ADR 0130).

  Every fleet is scoped to one directory, which is right for work and wrong for resources: each checkout reads the same host capability profile, concludes the machine affords N workers, and spends that budget alone. These slices lay the foundation for one daemon that owns Worker processes across every project on a machine, while each project's bundle keeps owning the work.

  - **`redskilled` skeleton** (#2773) — a user-session singleton reachable over a unix socket, with lease ownership, auto-spawn, and an idle rule that never exits while a Worker is alive.
  - **A Worker is born through the daemon** (#2774) — the daemon plans placement from injected probes and launches the Worker into a transient service unit of its own, so the resource charge lands at birth rather than being reassigned later.
  - **Project identity resolves once** (#2778) — a declared `project.name` wins, then the git remote, then the checkout basename; the filesystem slug always carries a short hash of the git common directory, which makes a collision between independent clones impossible by construction while collapsing a repository's worktrees onto the project they belong to.
  - **The Worker state file becomes TOON/TOONL** (#2783) — the state file stops violating the repository's own encoder mandate, and its entry leaves the JSON file-I/O allowlist.

### Patch Changes

- @reddb-io/shared@2.88.0
- @reddb-io/build-info@2.88.0

## 2.87.7

### Patch Changes

- @reddb-io/shared@2.87.7
- @reddb-io/build-info@2.87.7

## 2.87.6

### Patch Changes

- @reddb-io/shared@2.87.6
- @reddb-io/build-info@2.87.6

## 2.87.5

### Patch Changes

- @reddb-io/shared@2.87.5
- @reddb-io/build-info@2.87.5

## 2.87.4

### Patch Changes

- @reddb-io/shared@2.87.4
- @reddb-io/build-info@2.87.4

## 2.87.3

### Patch Changes

- @reddb-io/shared@2.87.3
- @reddb-io/build-info@2.87.3

## 2.87.2

### Patch Changes

- 1115db5: Harden the repo and AFK flow against untrusted external contributions (#2603):

  - New `CONTRIBUTING.md` documents the spec-first policy (ideas as issues;
    unsolicited feature PRs closed by policy), the diff-only fork-review posture,
    and the audited GitHub Actions fork posture.
  - The `red-issues-needs-triage` workflow now marks external-author issues **and**
    PRs with an auto-created `origin:external` label, resolving author write access
    via the collaborators permission API (fail-safe: undeterminable → external).
  - The `/afk` claim path refuses to execute an `origin:external` issue — parking
    it `ready-for-human` — until a maintainer posts `/approve-external`, verified
    through the existing write-access trust resolver. Integrated into
    `evaluateClaimTrust`; an approval also vouches for the external author on the
    fail-closed path while still requiring a maintainer promoter.
  - `/triage` docs and `triage-labels.md` treat external-origin bodies as
    untrusted data and document the new label + gate.
  - @reddb-io/shared@2.87.2
  - @reddb-io/build-info@2.87.2

## 2.87.1

### Patch Changes

- @reddb-io/shared@2.87.1
- @reddb-io/build-info@2.87.1

## 2.87.0

### Patch Changes

- @reddb-io/shared@2.87.0
- @reddb-io/build-info@2.87.0

## 2.86.2

### Patch Changes

- @reddb-io/shared@2.86.2
- @reddb-io/build-info@2.86.2

## 2.86.1

### Patch Changes

- @reddb-io/shared@2.86.1
- @reddb-io/build-info@2.86.1

## 2.86.0

### Patch Changes

- @reddb-io/shared@2.86.0
- @reddb-io/build-info@2.86.0

## 2.85.1

### Patch Changes

- @reddb-io/shared@2.85.1
- @reddb-io/build-info@2.85.1

## 2.85.0

### Patch Changes

- @reddb-io/shared@2.85.0
- @reddb-io/build-info@2.85.0

## 2.84.1

### Patch Changes

- c86e487: Claim explicitly dispatched issues before shared boot hygiene, expose booting workers in vitals, and serialize validation gates host-wide.
  - @reddb-io/shared@2.84.1
  - @reddb-io/build-info@2.84.1

## 2.84.0

### Patch Changes

- @reddb-io/shared@2.84.0
- @reddb-io/build-info@2.84.0

## 2.83.0

### Patch Changes

- @reddb-io/shared@2.83.0
- @reddb-io/build-info@2.83.0

## 2.82.0

### Patch Changes

- @reddb-io/shared@2.82.0
- @reddb-io/build-info@2.82.0

## 2.81.0

### Minor Changes

- b668e65: Attempts now keep their base fresh instead of letting drift accumulate until
  landing pays for it. A notes-loop attempt merges `origin/<trunk>` into its
  working branch at every iteration boundary (`afk.notes_loop.trunk_sync`, on by
  default): uncommitted work is never merged over, and a conflicting merge is
  aborted and handed to the inner agent as its first instruction in the next
  iteration. Landing gained the companion refusal — measured after the squash, a
  branch more than 40 commits ahead of a base more than 12h stale parks with the
  guard's own actionable reason instead of grinding a rebase that cannot
  converge. (#2481)

### Patch Changes

- e7ef0d0: Rename the dev plugin's MCP servers to colon-free names: `dev:afk` → `castle` and
  `code-nav` → `navigator`. Codex rejects `:` in MCP server names, which broke every
  `dev:*` form. The AFK launcher is now `plugins/dev/hooks/castle-mcp.sh`, the bundle
  is `castle-mcp.bundle.min.mjs`, and the npm bin is `red-skills-castle-mcp`. Pure
  rename, zero behavior change; takes effect on the next plugin update.
  - @reddb-io/shared@2.81.0
  - @reddb-io/build-info@2.81.0

## 2.80.0

### Minor Changes

- 70b50c3: Landing squashes a worker branch's own micro-history to one commit at its fork
  point before the pre-merge rebase, so a 60-commit retry chain presents ONE
  consolidated conflict set instead of replaying every continuous-push commit
  sequentially onto fresh trunk. Branch adoption (re-claim resume) now opens with
  a mandatory base sync instruction — fetch + rebase onto origin/<base>, resolving
  conflicts while the agent is present and drift is smallest. (#2481)

### Patch Changes

- 7ae5d01: Skill docs now teach the npx direct-run form (`npx -y -p @reddb-io/red-skills@<version>
red-skills-dev ...`) as the canonical invocation everywhere; a bare `red-skills-dev`
  shim is demoted to a warm-cache optimization. Field installs without the shim
  followed the old docs into command-not-found failures.
  - @reddb-io/shared@2.80.0
  - @reddb-io/build-info@2.80.0

## 2.79.1

### Patch Changes

- 46aed06: Ship the changesets-flow reliability tail that landed after the v2.79.0 npm
  publish was cut from the pre-migration branch: ordered publish retries with
  tail reconciliation, CI running on the `changeset-release/main` branch, the
  bypass-credential check scoped to the release flow, and the release/README
  documentation for the Version Packages PR + tag-triggered `red-publish` flow
  (ADR 0121). This cut also re-aligns the published npm content with `main`,
  which the transitional v2.79.0 tarball predates.
  - @reddb-io/shared@2.79.1
  - @reddb-io/build-info@2.79.1

## 2.79.0

### Minor Changes

- 31b4f21: Releases now flow through a changesets Version Packages PR and a tag-triggered
  publish workflow (ADR 0121). The version bump lands as a normal reviewed PR
  instead of being pushed straight to protected `main`, which retires the
  `RED_RELEASE_TOKEN` admin bypass, the GH006 side-branch fallback,
  `release-push-bump.sh`, and the conventional-commit bump decider.

### Patch Changes

- @reddb-io/shared@2.79.0
- @reddb-io/build-info@2.79.0
