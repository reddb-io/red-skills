# Workflow cost policy

Requested by the maintainer on 2026-11-05: keep automatic CI small and make
expensive validation optional. `quick-checks.yml` is the only automatic
quality workflow. It checks changed whitespace, workflow syntax, root/workspace
manifests and this trigger policy on one standard Ubuntu runner, with a
three-minute limit. It does not compile products or run full test suites.

Integration/browser tests, coverage, benchmarks, cross-platform matrices and
operational deployments are available through `workflow_dispatch`. They are
not required PR statuses. Recurring validation and watcher schedules are off.
Existing issue/comment routing remains available; releases only react to
intentional version tags, release events or an explicit manual action.
Artifact source/version/checksum and publication checks stay with publication.

## Run an optional workflow

In GitHub Actions, select its workflow, choose **Run workflow**, then select
the branch and inputs. From the CLI:

```sh
gh workflow run <file.yml> --repo reddb-io/red-skills --ref main
```

A workflow using `workflow_call` is a component of its parent operation.
Run the parent rather than dispatching a component without its required inputs.
Manual deployment and publication commands retain their existing environment,
identity and version requirements; this policy does not publish anything itself.

## Available workflows

| File | Events |
| --- | --- |
| `red-workspace-ci.yml` | workflow_dispatch |
