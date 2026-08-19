---
name: red-gains
working-mode: interactive
description: Shows the detailed rsp usage-gains report from the shared RedDB telemetry store. Use when the user invokes `/red-gains`, asks whether rsp is paying for itself, wants token-savings trends, latency percentiles, throughput heatmaps, degradation history, or which wrapped command saves the most tokens.
argument-hint: "[--since 28d]"
disable-model-invocation: true
---

# /red-gains

<what-to-do>

**Run the shim** — execute `rsp gains [--since 28d]` from the current repo.

**Summarize the signal** — render a human-readable report with four highlights:
trend, anomalies, which command pays the bill, and whether health degraded.

**Keep the source visible** — preserve the TOON facts from `rsp gains`; do not
invent numbers that are absent from the telemetry store.

</what-to-do>

<supporting-info>

## Report Shape

`rsp gains` reads `rsp_telemetry_invocations_v1` and
`rsp_telemetry_degradations_v1` from the shared RedDB store and emits TOON with:

- latency: global and per-command-family wrapper percentiles.
- throughput: requests per day, active-minute average, peak minute, and
  hour-by-weekday activity.
- savings: weekly tokens saved, week-over-week delta, elision rate, top command
  families by tokens saved and invocation count, and the single biggest elision.
- health: degradation timeline plus cold-boot and warm-hit counts when
  telemetry contains enough resident-store metrics.

## Empty And Short Windows

Empty stores are definitive states, not errors. Report them as "no rsp telemetry
in this window".

Short windows are normal after setup or pruning. Use the `window.label` value,
for example "window: 28d, data: 3d", so the reader sees requested history
versus available history.

For rsp hook silence, resident/store splits, and store-growth recovery, see
[TROUBLESHOOTING.md](../../../../../apps/rsp/docs/TROUBLESHOOTING.md).

</supporting-info>
