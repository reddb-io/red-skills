# RSP command-boundary benchmark

Reference sample: 40 warm passthrough invocations plus one cold invocation.

| Metric | Result | Budget |
| --- | ---: | ---: |
| Cold invocation | 67.78 ms | ≤ 200 ms |
| p95 passthrough overhead | 39.60 ms | ≤ 50 ms |
| p95 structured transformation | 1.76 ms | ≤ 100 ms |
| Raw p50 / p95 / p99 | 25.34 / 29.02 / 30.30 ms | — |
| RSP p50 / p95 / p99 | 59.97 / 68.62 / 69.62 ms | — |

Verdict: **pass**.
