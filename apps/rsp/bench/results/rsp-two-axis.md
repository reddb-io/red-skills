rsp two-axis benchmark: 14 fixtures across 7 filters

| Filter | Fixtures | rsp median/p90 token delta | rsp fidelity | RTK median/p90 token delta | RTK fidelity |
| --- | ---: | ---: | ---: | ---: | ---: |
| cargo:test | 3 | 61.9/84.2% | 100% | 67.8/82.4% | 100% |
| git:commit | 1 | -109.1/-109.1% | 100% | -78.8/-78.8% | 100% |
| git:diff | 1 | -111.5/-111.5% | 100% | -23.1/-23.1% | 100% |
| git:log | 1 | -30.7/-30.7% | 100% | 59.1/59.1% | 100% |
| git:push | 2 | -37.1/0% | 100% | 13.8/27.6% | 100% |
| git:status | 2 | 60.5/75% | 100% | 23.7/72.3% | 100% |
| vitest:run | 4 | 58.8/86.8% | 100% | 86.3/92.8% | 100% |

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | fail | 100% | 100% |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
External context-optimization claims are cited literature only and were not locally reproduced.
