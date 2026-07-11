rsp two-axis benchmark: 18 fixtures across 7 filters

Production mode uses admission threshold 60%; passthrough filters count as 0% token delta because rsp returns the original command output.

| Filter | Mode | Fixtures | brief shipped delta | brief fidelity | brief hyp-active delta | terse shipped delta | terse fidelity | terse hyp-active delta | RTK median/p90 token delta | RTK fidelity |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cargo:test | active | 3 | 61.9/84.2% | 100% | 61.9/84.2% | 57.7/84.2% | 100% | 57.7/84.2% | 67.8/82.4% | 100% |
| git:commit | passthrough | 1 | 0/0% | 100% | 42.4/42.4% | 0/0% | 100% | 42.4/42.4% | -78.8/-78.8% | 100% |
| git:diff | passthrough | 2 | 0/0% | 100% | -56/-0.4% | 0/0% | 100% | -21.6/99.1% | 38.3/99.6% | 100% |
| git:log | passthrough | 2 | 0/0% | 100% | -35.4/-5% | 0/0% | 100% | 13.7/98.4% | 52.3/99.3% | 100% |
| git:push | active | 2 | 31.9/63.8% | 100% | 31.9/63.8% | 31.9/63.8% | 100% | 31.9/63.8% | 13.8/27.6% | 100% |
| git:status | active | 2 | 60.5/75% | 100% | 60.5/75% | 60.5/75% | 50% | 60.5/75% | 23.7/72.3% | 100% |
| vitest:run | active | 6 | 58.8/100% | 100% | 58.8/100% | 70/100% | 100% | 70/100% | 86.3/100% | 100% |

Large-output filters: git:diff, git:log, vitest:run.

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | pass | 100% | 100% |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
External context-optimization claims are cited literature only and were not locally reproduced.
