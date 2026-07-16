# Prototype: `.red/` layout for the relocated engine

Asset of wayfinder map #1875, ticket #1881. Ratified by maintainer grilling 2026-07-16
(four reactions locked: durable/tmp split; `worktrees/workers/` sub-lane; `castle`
namespace; liveness lane stays separate).

## Directory scheme

```
.red/
├── state/                          # Tier 3 — DURABLE (survives tmp rm / reboot)
│   ├── castle/                     #   engine-owned (boot-migrates from .red/state/afk/)
│   │   ├── history.toonl           #   drain ledger (was afk-history.toonl)
│   │   ├── supervisor.state.toon   #   last fleet snapshot (was afk-supervisor.state.json)
│   │   ├── restarts.toon           #   watchdog restart ledger
│   │   └── runner-circuit/         #   per-runner circuit-breaker state
│   ├── statusline/                 #   unchanged (dev-side reader cache)
│   ├── branch-lock.yaml            #   unchanged
│   └── red-skills.rdb              #   unchanged
│
└── tmp/                            # Tier 4 — rm -rf safe
    ├── supervisors/$id/
    │   ├── supervisor.pid
    │   ├── supervisor.log.toonl    # structured firehose (was afk-supervisor.log.jsonl)
    │   └── supervisor.log          # human prose
    ├── workers/$workerId/          # ONE lane; kind (afk|go|scout) lives in state.toon
    │   ├── worker.pid
    │   ├── state.toon              # identity + kind + vitals (merges afk.state.json + identity.json)
    │   ├── worker.log.toonl        # lifecycle + vitals + scale/steer/escalate events
    │   ├── worker.log              # human log (was afk.log)
    │   └── liveness.toonl          # castle substrate lane — SEPARATE file (un-poisonable, ADR 0083 §3)
    ├── worktrees/
    │   ├── workers/$workerId-$issueId/   # engine worktrees sub-lane (no attempt level)
    │   │   ├── worktree/           # the git checkout
    │   │   ├── state.toon          # issue-scoped phase + validation refs
    │   │   └── validation.toonl    # gate sidecar (was validation.jsonl)
    │   └── manual/ feedback/ landing/ rebase/ cascade/ adopt/ docs/   # human/aux lanes unchanged
    ├── monitors/$id/
    │   ├── monitor.pid
    │   └── monitor.log.toonl
    ├── claims/$issueId/            # mkdir lease — unchanged
    ├── waits/                      # rsp wait registry — unchanged
    ├── land.lock                   # landing serialization (was afk-land.lock)
    └── scratch/  diagnostics/  logs/$date/   # unchanged
```

## Path module shape

```ts
// packages/red-castle/src/engine/paths.ts
// The engine RECEIVES the .red root — it never hardcodes `.red-castle/` in embedded mode.
// All structured writes go through @reddb-io/toon (.toon snapshots, .toonl lanes).

export interface EnginePaths {
  // durable tier
  historyLedger(): string;                      // state/castle/history.toonl
  supervisorState(): string;                    // state/castle/supervisor.state.toon
  restartsLedger(): string;                     // state/castle/restarts.toon
  runnerCircuitDir(): string;                   // state/castle/runner-circuit/
  // disposable tier, per entity
  supervisorDir(id: SupervisorId): string;      // tmp/supervisors/<id>/
  workerDir(id: WorkerId): string;              // tmp/workers/<id>/
  workerState(id: WorkerId): string;            // tmp/workers/<id>/state.toon
  workerLiveness(id: WorkerId): string;         // tmp/workers/<id>/liveness.toonl
  worktree(w: WorkerId, issue: number): string; // tmp/worktrees/workers/<w>-<issue>/
  monitorDir(id: MonitorId): string;            // tmp/monitors/<id>/
  claimDir(issue: number): string;              // tmp/claims/<issue>/
  landLock(): string;                           // tmp/land.lock
}

export function enginePaths(redRoot: string): EnginePaths;
```

## Migration notes

- **Idempotent boot migration** (the #1685 pattern): `state/afk/` → `state/castle/` rename once;
  legacy `tmp/{workers,go-workers,scout-workers}/…/{issue}-a{N}` dirs are left to expire via the
  per-lane TTL janitor — readers learn only the new grammar.
- **Kind field replaces per-kind roots**: `go-workers/`/`scout-workers/` die; monitors/statusline
  filter `state.toon` `kind`.
- **Guardrail lockstep**: the shell command-guard keeps a single literal (`.red/tmp/worktrees/`);
  the sensitive-path regex updates in the same slice (hooks ticket owns the drift guard).
- **Sidecar grammar**: `worker-state-reader`'s `<worker>/<issue>-a<N>` parsing is replaced by the
  `workers/<id>/state.toon` + `worktrees/workers/<wid>-<issue>/state.toon` pair (contracts ticket
  versions the schemas).
