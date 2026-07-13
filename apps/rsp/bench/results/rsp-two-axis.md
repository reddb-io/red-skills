rsp two-axis benchmark: 27 fixtures across 10 filters

Production mode uses admission threshold 60%; passthrough filters count as 0% token delta because rsp returns the original command output.

| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | oracle tokens | rsp capture | RTK capture | brief shipped delta | brief fidelity | terse shipped delta | terse fidelity |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cargo:test | active | 3 | 478 | 202 | 132 | 203 | 99.5% | 65% | 61.9/84.2% | 100% | 57.7/84.2% | 100% |
| gh:issue | passthrough | 3 | 123 | 123 | rtk: not-covered | 80 | 0% | rtk: not-covered | 0/0% | 100% | 0/0% | 100% |
| gh:pr | passthrough | 3 | 108 | 108 | rtk: not-covered | 64 | 0% | rtk: not-covered | 0/0% | 100% | 0/0% | 100% |
| gh:run | passthrough | 3 | 121 | 121 | rtk: not-covered | 49 | 0% | rtk: not-covered | 0/0% | 100% | 0/0% | 100% |
| git:commit | passthrough | 1 | 33 | 33 | 59 | 23 | 0% | 0% | 0/0% | 100% | 0/0% | 100% |
| git:diff | passthrough | 2 | 7526 | 7526 | 62 | 7584 | 99.2% | 0.8% | 0/0% | 100% | 0/0% | 100% |
| git:log | passthrough | 2 | 4467 | 4467 | 68 | 4717 | 94.7% | 1.4% | 0/0% | 100% | 0/0% | 100% |
| git:push | active | 2 | 58 | 21 | 63 | 28 | 75% | 0% | 31.9/63.8% | 100% | 31.9/63.8% | 100% |
| git:status | active | 2 | 153 | 79 | 54 | 83 | 95.2% | 65.1% | 60.5/75% | 100% | 60.5/75% | 50% |
| vitest:run | active | 6 | 51368 | 654 | 208 | 442 | 99.6% | 47.1% | 58.8/100% | 100% | 70/100% | 100% |

Aggregate oracle ceiling: raw 64435 tokens (0% capture), rsp 13334 tokens (99.9% capture), RTK 646 tokens (4.9% capture), oracle 13273 tokens.

Large-output filters: git:diff, git:log, vitest:run.

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | pass | 100% | 100% |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
External context-optimization claims are cited literature only and were not locally reproduced.
