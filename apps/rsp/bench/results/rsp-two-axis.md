rsp two-axis benchmark: 17 fixtures across 7 filters

Production mode uses admission threshold 60%; passthrough filters count as 0% token delta because rsp returns the original command output.

| Filter | Mode | Fixtures | brief median/p90 token delta | brief fidelity | terse median/p90 token delta | terse fidelity | RTK median/p90 token delta | RTK fidelity |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cargo:test | active | 3 | 61.9/84.2% | 100% | 61.9/84.2% | 100% | 67.8/82.4% | 100% |
| git:commit | passthrough | 1 | 0/0% | 100% | 0/0% | 100% | -78.8/-78.8% | 100% |
| git:diff | passthrough | 2 | 0/0% | 100% | 0/0% | 100% | 38.3/99.6% | 100% |
| git:log | passthrough | 2 | 0/0% | 100% | 0/0% | 100% | 79.4/99.7% | 100% |
| git:push | passthrough | 2 | 0/0% | 100% | 0/0% | 100% | 13.8/27.6% | 100% |
| git:status | active | 2 | 60.5/75% | 100% | 60.5/75% | 50% | 23.7/72.3% | 100% |
| vitest:run | active | 5 | 64.1/100% | 100% | 64.1/100% | 100% | 87.4/100% | 100% |

Large-output filters: git:diff, git:log, vitest:run.

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | pass | 100% | 100% |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
External context-optimization claims are cited literature only and were not locally reproduced.
