# afk detectors

Shipped detectors invoked by the generic hook orchestrator
(`scripts/hooks.sh::hooks_run`) at the `pre-spawn` hook point. Each
detector is a self-contained shell script that decides, on its own,
whether it applies to the current project; if so, it writes
`KEY=value` exports into `$AFK_HOOK_ENV_FILE` and exits 0. The
orchestrator sources that env-file back into the spawn shell, so a
detector's exports propagate to the worker.

## Convention

A detector is a single `*.sh` file in this directory. Project-local
detectors at `<project>/.red/hooks/detectors/*.sh` follow the same
convention. Each script must:

1. Run an **applicability check** first. If the detector does not
   apply to the current project (or required opt-in env vars are
   unset), `exit 1` immediately. Exit code 1 means "not applicable"
   to the orchestrator — it is never an error and never appears in
   the boot-log.
2. If applicable, write zero-or-more `KEY=value` lines to
   `$AFK_HOOK_ENV_FILE`, then `exit 0`. The env-file is unique per
   invocation and the orchestrator deletes it after sourcing.
3. Any other exit code is treated as an error. On a `pre-*` hook the
   orchestrator aborts; on a `post-*` hook it logs and continues.

The orchestrator runs detectors in C-locale alphabetical order:
shipped first, then project. Detectors share no state — each runs in
its own subprocess with a fresh `$AFK_HOOK_ENV_FILE`.

## Available env

The orchestrator exports the standard AFK contract before invoking a
detector:

- `AFK_SLOT` — supervisor slot index (defaults to `0` when not run
  under the supervisor).
- `AFK_PLUGIN_DIR`, `PROJECT_ROOT` — discovery roots.
- `AFK_HOOK_ENV_FILE` — the path the detector must write to.

## Disabling a shipped detector

Set the matching key under `afk.hooks.defaults` in `.red/config.yaml`
to `false`:

```yaml
afk:
  hooks:
    defaults:
      cargo: false
```

Project detectors are never gated by config — they only exist when
the project authored the file.

## Shipped detectors

- **`cargo.sh`** — applies on Rust projects (`Cargo.toml` present).
  Exports `CARGO_TARGET_DIR=${CARGO_TARGET_BASE:-/opt/cargo-target}/slot-${AFK_SLOT}`,
  pre-creating the directory with `mkdir -p` so the first run on a
  fresh host succeeds. Override the base with `CARGO_TARGET_BASE`.
- **`gradle.sh`** — applies on Gradle projects (`build.gradle*`
  present) **and** only when `GRADLE_USER_HOME_BASE` is set in the
  supervisor's env. Without that base var the detector is a no-op
  (exits 1) — opt-in so we never claim a path on the user's
  filesystem without consent. When both conditions hold, exports
  `GRADLE_USER_HOME=${GRADLE_USER_HOME_BASE}/slot-${AFK_SLOT}`,
  pre-creating the directory.

Both detectors give each worker slot its own build cache so Cargo
and Gradle never serialize on shared lock files.
