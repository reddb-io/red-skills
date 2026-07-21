# 0116 — A disabled plugin sees no config, decided in the loader

- **Status**: accepted
- **Date**: 2026-07-21
- **Related**: ADR 0067 (per-directory plugin activation gate), ADR 0042 (one `.red/config.yaml`, `plugins.<name>.*` namespacing), ADR 0117 (retired config keys carry a tombstone), ADR 0113 (castle owns the truth, dev owns the host boundary)

## Context

ADR 0067 made plugin activation **strict opt-in**: a directory runs the dev
plugin only when its `.red/config.yaml` sets `plugins.dev.enabled: true`. The
gate is implemented in `packages/shared/plugin-gate.ts` and consulted by the hook
launchers — that is, **at process entry**.

The config loader (`apps/dev/src/core/config.ts`) knew nothing about it. Given a
path it parsed the file and returned every key, opted in or not. So the gate held
only for callers that came through the entrypoint; any in-process caller that
loaded config directly — a command invoked another way, a doctor, a future
module — read a disabled directory's runner, model table, and backpressure
commands as if the directory had opted in. The gate was a property of one call
path rather than of the configuration itself.

The castle twin (`packages/red-castle/src/engine/config.ts`) does not have this
gap: `loadEngineConfig` computes `enabled` from the parsed file and applies the
file's values *and* the environment overrides only when it is true. #2231
catalogued that as a twin-encoded decision the proven side does not make, and
#2245 ruled it **harvested**.

## Decision

**The activation gate is decided in the config loader. A directory that has not
opted in yields the documented defaults and none of its own settings.**

- `auditConfigLoad` computes `pluginEnabled` from `plugins.dev.enabled === "true"`
  — the same predicate as `pluginEnabledInConfig`, kept in lockstep — and, when
  it is false, returns `configDefaults()` with `gateClosed: true`.
- `gateClosed` is **distinct from `discarded`**. `discarded` means the YAML was
  malformed; a gate-closed load is a healthy file that this directory simply has
  not opted into. Conflating them would make the coherence probe report a
  perfectly good config as broken.
- **Diagnostics still run for a gate-closed file.** Root-accessor collisions and
  retired keys (ADR 0117) are reported and warned either way: they describe the
  file as data, they do not steer behaviour.
- `LoadConfigOptions.ignoreActivationGate` is the **inspection-only** bypass, for
  reading a not-yet-enabled directory's file *as data* — a doctor reporting what
  a repo has written, `/red-setup` inspecting a config it is about to amend.
  Passing it to decide behaviour puts the gate back to advisory.
- **A kill switch is not a setting.** Fail-closed must never turn an operator's
  "off" into an "on", so a suppression predicate reads past the gate.
  `statuslineEnabled` is the one such reader today: a directory that says
  `statusline: false` is still obeyed when the host invokes the command directly.

Dev's environment overrides need no separate rule: unlike castle, dev's loader
has no env layer — `RED_AFK_*` is read by the supervisor entry, which is already
behind the ADR 0067 process-entry gate.

## Consequences

- **The gate is a property of the configuration, not of one call path.** A new
  in-process caller inherits fail-closed behaviour without knowing the gate
  exists — the failure mode that motivated this record is unreachable by
  construction, not by convention.
- **Test fixtures got more honest.** Cases that exercise the grammar and the ADR
  0042 namespace fold now say `ignoreActivationGate: true` (they read the fixture
  as data); cases that exercise runtime settings resolution carry
  `plugins.dev.enabled: true`, which is what a real repo looks like.
- **A repo using only the legacy top-level `afk:` block, with no opt-in, now
  reads as defaults.** That is the ADR 0067 semantic stated plainly: without the
  explicit opt-in the plugin was never active there anyway.
- **What config does NOT own is now visible by contrast.** The triage label
  vocabulary is deliberately **hardcoded** in `core/triage-labels.ts`, not
  operator-overridable. #2245 ruled directly on that opposition — the castle twin
  treats the vocabulary as config, dev's "never redefine these inline" doctrine
  survives. Labels are the runtime's own protocol (the close cascade, the boot
  sweep, and `/hitl` all parse them); a repo that renames them does not customise
  AFK, it breaks it. Config tunes behaviour; it does not redefine vocabulary.
