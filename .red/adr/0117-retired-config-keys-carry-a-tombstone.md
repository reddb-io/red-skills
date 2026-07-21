# 0117 — Retired config keys carry an explicit tombstone

- **Status**: accepted
- **Date**: 2026-07-21
- **Related**: ADR 0042 (one `.red/config.yaml`, `plugins.<name>.*` namespacing), ADR 0116 (a disabled plugin sees no config), ADR 0044/0045 (commit-anchored attempt progress guard — the change that retired `afk.attempt_timeout`)

## Context

The config loader tolerates unknown keys on purpose: a newer `.red/config.yaml`
must stay readable by an older binary. That forward-compat tolerance has a cost —
a key that **used to** mean something and a key that does not mean anything
**yet** are indistinguishable. Both are parsed, carried in the map, and never
read.

So when a setting is retired, every repo still carrying it keeps a line that
looks live and does nothing. `afk.attempt_timeout` is the concrete case: it was
the wall-clock attempt cap until ADR 0044/0045 replaced it with the
commit-anchored progress guard. A repo that still sets it believes it is tuning a
timeout; nothing reads the key.

The castle twin keeps a `DELETED_CONFIG_KEYS` set and drops those keys at load.
#2231 catalogued it as "same effect today, but dev cannot distinguish a retired
key from an unknown forward-compat one"; #2245 ruled it **harvested**.

## Decision

**Every retired config key is named in an explicit tombstone set. The loader
drops it and warns; it is never readable through any accessor.**

- `DELETED_CONFIG_KEYS` in `apps/dev/src/core/config.ts` lists **both spellings**
  of each retired key — the canonical namespaced one (`plugins.dev.…`, ADR 0042)
  and the legacy top-level accessor — because either can still be sitting in a
  repo's config.
- A tombstoned key is skipped in both fold passes, so `getConfig` returns `""`
  for it exactly as for a key that never existed. Removing the reader and
  tombstoning the key are one change, not two.
- The loader warns `RETIRED — it no longer does anything`, naming the file. An
  unknown forward-compat key stays silent: silence means "not yet", a warning
  means "not any more".
- `ConfigLoadAudit.retiredKeys` reports them, **including for a gate-closed file**
  (ADR 0116), so a doctor can name stale keys in a directory that has not opted
  in.

**Retiring a key is:** delete its reader, add both spellings to
`DELETED_CONFIG_KEYS`, and record the removal in the ADR that retires it.

## Consequences

- **Stale config is discoverable instead of inert.** An operator learns the
  setting stopped applying at the moment the loader reads it, rather than after
  wondering why a tuned value has no effect.
- **A guard test keeps the set honest**: no tombstoned key may also have a live
  entry in `CONFIG_DEFAULTS`. A key cannot be both retired and documented.
- **The set only grows on a real removal.** It is not a deprecation lane — a key
  that still works does not belong here; tombstone it when the reader dies.
