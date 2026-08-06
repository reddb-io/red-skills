# rsp Troubleshooting

Use this reference when rsp hook routing, resident service behavior, or elision storage looks silent, stale, or unbounded. Follow the `writing-for-agents` TROUBLESHOOTING convention: Symptom -> Confirm -> Recover -> Root fix.

**Diagnose the resident first.** The resident is the core and the CLI, the wrappers, the pre-exec hook, the proxy, and the MCP server are peer clients of it (ADR 0126) — one unreachable resident makes every surface look independently broken. Start at `## Resident unreachable`; only once the resident answers is a surface-specific symptom (hook silence, store growth) worth chasing.

## Resident unreachable

### Symptom

Every rsp surface degrades at once: wrappers print raw command output with no summary, `rsp stats` and the bare dashboard show nothing, the hook records `failed-open` or stays silent, and the MCP tools return uncompressed payloads. Nothing errors — that is the fail-open guarantee working, not a second bug.

### Confirm

Separate a resident that **never started** from one whose socket is registered but dead:

```bash
rsp status
rsp server
```

`rsp status` reads the PID registry and reports the resident as registered-and-reachable, registered-but-stale, or absent. **Absent** means the resident never started: auto-spawn was blocked (repo not opted into `rsp.enabled`, no writable `.red/state/rsp`, or the binary could not fork), and there is no socket to connect to. **Stale** means a registry entry and socket path exist but the process behind them is gone or wedged — a stale socket, where clients connect and get nothing. A foreground `rsp server` run makes the difference explicit: it either accepts requests, or prints the spawn failure that auto-spawn was swallowing.

### Recover

For an absent resident, fix the reason auto-spawn could not run — confirm `.red/config.yaml` sets `rsp.enabled: true` and that `.red/state/rsp` is writable — then re-run any rsp command; the first client call spawns the resident. For a stale socket, stop the registered resident and let the next rsp command start a fresh process; do not delete `.red/state/red-skills.rdb`, which also carries unrelated repo state.

While the resident is down, every surface stays usable because it fails open. The exact observable behaviour, surface by surface:

| Surface | Behaviour with no reachable resident |
| --- | --- |
| Wrappers and `rsp proxy` | Run the raw command and hand back its stdout, stderr, and exit status verbatim; the proxy records the decision as `failed-open`. |
| Pre-exec hook | Wakes the resident and passes the command through unrewritten for that invocation; the next command can use the wrapper. |
| `rsp stats`, bare `rsp` dashboard | Degrade to the empty snapshot rather than erroring. |
| `rsp wait` | Keeps its spooled bytes instead of minting an `el:<id>` handle nothing can recover; the verdict and exit code are unaffected. |
| MCP tools (`rsp_compress`, `rsp_show`, …) | Each returns the payload it was handed, uncompressed. |

An unreachable resident **costs the elision, never the command** — if a command result is lost or an exit status changes, that is a defect to report, not fail-open.

**`rsp-resident-entry-unresolved` means the host cannot find an rsp to spawn.** The auto-spawn resolves the rsp entrypoint explicitly — an explicit `serverCommand`, `RSP_BIN`, the caller's own entry when it *is* an rsp entry, the rsp bundle beside the host bundle, the plugin-root bundle, the repo `dist/`, the workspace entry, then the bundle cache — and says this name once per process when none of them exists (#2736). It is emitted by hosts that are not the rsp CLI (the dev bundle, castle-mcp, memory, brain), and it never blocks the command. Recover by installing the rsp bundle where the host can see it (`/red-setup`) or by setting `RSP_BIN` to the rsp binary.

### Root fix

`rsp status` should classify absent, stale, and unreachable-but-live in one actionable line so this manual split is unnecessary; the resident-health reporting work is tracked by #1731.

## Hook silence

### Symptom

A command that should be rewritten by the rsp pre-exec hook runs raw, produces no rsp decision telemetry, and gives no visible error. The failure may be a hook fail-open, a resident/proxy issue, or a repo opt-in mismatch.

### Confirm

Run the three-command split before changing hooks or config:

```bash
printf '%s\n' '{"tool_name":"Bash","tool_input":{"command":"git status --short"}}' | node dist/dev.bundle.min.mjs hook pre-tool-use
cd ../second-redskills-enabled-repo && git status --short
RSP_DEBUG=1 git status --short
```

The synthetic PreToolUse payload should show whether the shipped hook bundle can parse and rewrite the command. The second enabled repo is the control: if it rewrites there, the current repo's resident state, config, or store is suspect; if it is silent there too, the intercept surface is suspect. With `RSP_DEBUG=1`, expect a concrete hook decision such as contributed, passed, or failed-open; no debug decision means the hook did not run.

### Recover

If only the current repo is silent, re-run setup for the repo and restart the host session so the generated hook path and `.red/config.yaml` opt-in are reloaded. If both repos are silent but the synthetic payload rewrites, restart the host session and confirm the hook bundle installed by the host points at the current dev bundle. If the synthetic payload fails, treat the shipped bundle or hook contract as broken and use direct `rsp ...` wrappers until the hook is fixed.

### Root fix

This manual split is a stopgap for the hook diagnosis and intercept hardening tracked by #1731 and #1726. The durable fix is for hook telemetry and setup validation to make fail-open silence distinguishable without a hand-built payload/control test.

## Resident/store split

### Symptom

`rsp show`, `rsp stats`, `rsp gains`, or proxy routing is slow, empty, or failing, and it is unclear whether the resident daemon is unhealthy or the shared store cannot read/write.

### Confirm

Separate the process plane from the store plane:

```bash
rsp status
rsp server
du -b .red/state/red-skills.rdb && sleep 30 && du -b .red/state/red-skills.rdb
```

The registry status should identify whether a resident is registered, reachable, stale, or absent. A foreground server run should either accept requests or print the daemon failure directly. The idle byte-stability measurement should stay flat when no commands are producing elisions or telemetry; growth during an idle window points at store churn rather than normal command output.

### Recover

For daemon failures, stop the stale resident if one is registered and let the next rsp command start a fresh process. For store failures, check that `.red/state/red-skills.rdb` exists, is writable, and was provisioned by setup; keep using raw commands or direct non-eliding wrappers while the shared store is unavailable. Do not delete the durable store as a first recovery step because it also carries other repo state collections.

### Root fix

This manual split is a stopgap for the resident and store diagnosis work tracked by #1731 and #1726. The root fix is for registry status, foreground serving, and store health checks to report a single actionable classification.

## Store growth

### Symptom

The rsp elision store or shared repo store appears to grow without bound after repeated command output, even when handles should be TTL-bound, byte-budgeted, compacted, or rotated.

### Confirm

Compare logical/live state with physical on-disk size:

```bash
rsp stats --full
du -b .red/state/red-skills.rdb
du -b .red/state/red-skills.rdb && rsp git log --terse && du -b .red/state/red-skills.rdb
```

The live view should show handle counts, bytes retained, and budget/TTL posture. The on-disk measurement is the physical-cap contract: it may lag logical deletion until compaction or rotation, but it must remain bounded. Re-running a large eliding command should increase live and physical size only within the configured cap and retention expectations.

### Recover

If logical retained bytes are below budget but the file keeps growing, capture the stats and before/after `du` measurements, then stop producing large elisions in that repo until compaction or rotation catches up. If both logical and physical sizes exceed the configured budget, lower the rsp byte budget temporarily or disable proxy contribution for noisy sessions while preserving the store for diagnosis.

### Root fix

This manual bound check is a stopgap for #1704. The root fix is the physical-cap contract: store compaction or rotation must enforce the on-disk ceiling, not only logical expiry.
