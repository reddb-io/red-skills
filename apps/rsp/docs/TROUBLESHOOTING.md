# rsp Troubleshooting

Use this reference when rsp hook routing, resident service behavior, or elision storage looks silent, stale, or unbounded. Follow the `write-a-skill` TROUBLESHOOTING convention: Symptom -> Confirm -> Recover -> Root fix.

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
