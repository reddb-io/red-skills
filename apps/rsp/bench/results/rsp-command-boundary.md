# RSP command-boundary benchmark

Reference sample: 40 warm passthrough invocations plus one cold invocation.

| Metric | Result | Budget |
| --- | ---: | ---: |
| Cold invocation | 55.13 ms | ≤ 200 ms |
| p95 passthrough overhead | 38.23 ms | ≤ 50 ms |
| Raw p50 / p95 / p99 | 26.07 / 29.94 / 30.54 ms | — |
| RSP p50 / p95 / p99 | 56.43 / 68.17 / 70.27 ms | — |

Verdict: **pass**.
