rsp two-axis benchmark: 27 fixtures across 10 filters

Production mode uses admission threshold 60%; passthrough filters count as 0% token delta because rsp returns the original command output.

| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | oracle tokens | rsp capture | RTK capture | brief shipped delta | brief fidelity | terse shipped delta | terse fidelity |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cargo:test | active | 3 | 478 | 202 | 132 | 203 | 99.5% | 65% | 61.9/84.2% | 100% | 57.7/84.2% | 100% |
| gh:issue | passthrough | 3 | 123 | 123 | rtk: not-covered | 80 | 0% | rtk: not-covered | 0/0% | 100% | 0/0% | 100% |
| gh:pr | passthrough | 3 | 108 | 108 | rtk: not-covered | 64 | 0% | rtk: not-covered | 0/0% | 100% | 0/0% | 100% |
| gh:run | passthrough | 3 | 121 | 121 | rtk: not-covered | 49 | 0% | rtk: not-covered | 0/0% | 100% | 0/0% | 100% |
| git:commit | passthrough | 1 | 33 | 33 | 59 | 69 | 47.8% | 85.5% | 0/0% | 100% | 0/0% | 100% |
| git:diff | passthrough | 2 | 7526 | 7526 | 62 | 7584 | 99.2% | 0.8% | 0/0% | 100% | 0/0% | 100% |
| git:log | passthrough | 2 | 4467 | 4467 | 68 | 4717 | 94.7% | 1.4% | 0/0% | 100% | 0/0% | 100% |
| git:push | passthrough | 2 | 58 | 58 | 63 | 102 | 56.9% | 61.8% | 0/0% | 100% | 0/0% | 100% |
| git:status | active | 2 | 153 | 79 | 54 | 83 | 95.2% | 65.1% | 60.5/75% | 100% | 60.5/75% | 50% |
| vitest:run | active | 6 | 51368 | 654 | 208 | 442 | 99.6% | 47.1% | 58.8/100% | 100% | 70/100% | 100% |

Aggregate oracle ceiling: raw 64435 tokens (0% capture), rsp 13371 tokens (99.8% capture), RTK 646 tokens (4.9% capture), oracle 13393 tokens.

Large-output filters: git:diff, git:log, vitest:run.

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | pass | 100% | 100% |

| Anti-suppression audit | Level | Verdict | Note |
| --- | --- | --- | --- |
| cargo:test | brief | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| cargo:test | terse | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| gh:issue | brief | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:issue | terse | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:pr | brief | audited: justified | empty-list sentinel is deliberate; non-empty list and view fixtures keep PR row/body TOON |
| gh:pr | terse | audited: justified | empty-list sentinel is deliberate; non-empty list and view fixtures keep PR row/body TOON |
| gh:run | brief | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:run | terse | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| git:commit | brief | audited: fixed | success output now renders commit id, branch, subject, and change counts as compact TOON |
| git:commit | terse | audited: fixed | success output now renders commit id, branch, subject, and change counts as compact TOON |
| git:diff | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:diff | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:log | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:log | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:push | brief | audited: fixed | success output now renders pushed refs and remote as compact TOON; rejected pushes remain byte-intact faults |
| git:push | terse | audited: fixed | success output now renders pushed refs and remote as compact TOON; rejected pushes remain byte-intact faults |
| git:status | brief | audited: justified | clean-tree sentinel is a deliberate definitive empty state; changed-tree output keeps row TOON |
| git:status | terse | audited: justified | clean-tree sentinel is a deliberate definitive empty state; changed-tree output keeps row TOON |
| vitest:run | brief | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| vitest:run | terse | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
External context-optimization claims are cited literature only and were not locally reproduced.
