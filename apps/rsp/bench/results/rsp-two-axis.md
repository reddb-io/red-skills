rsp two-axis benchmark: 31 fixtures across 14 filters
Corpus: home

Corpus provenance:
- Repo-authored rsp benchmark fixtures under apps/rsp/tests/fixtures.

Production mode uses admission threshold 60%; passthrough filters count as 0% token delta because rsp returns the original command output.

| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | Headroom tokens | oracle tokens | rsp capture | RTK capture | Headroom capture | brief shipped delta | brief fidelity-first score | terse shipped delta | terse fidelity-first score | RTK fidelity-first score | Headroom fidelity-first score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cargo:test | active | 3 | 478 | 202 | 132 | 468 | 203 | 99.5% | 65% | 3.6% | 61.9/84.2% | 100% | 57.7/84.2% | 100% | 100% | 100% |
| cat:file | active | 1 | 1489 | 332 | rtk: not-covered | headroom: not-covered | 166 | 87.5% | rtk: not-covered | headroom: not-covered | 77.7/77.7% | 100% | 87.1/87.1% | 100% | rtk: not-covered | headroom: not-covered |
| gh:issue | passthrough | 3 | 123 | 123 | rtk: not-covered | 123 | 80 | 0% | rtk: not-covered | 0% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| gh:pr | passthrough | 3 | 108 | 108 | rtk: not-covered | 108 | 64 | 0% | rtk: not-covered | 0% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| gh:run | passthrough | 3 | 121 | 121 | rtk: not-covered | 121 | 49 | 0% | rtk: not-covered | 0% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| git:blame | passthrough | 1 | 88 | 88 | rtk: not-covered | 88 | 83 | 0% | rtk: not-covered | 0% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| git:branch | passthrough | 1 | 64 | 64 | rtk: not-covered | 64 | 100 | 64% | rtk: not-covered | 64% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| git:commit | passthrough | 1 | 33 | 33 | 59 | 33 | 69 | 47.8% | 85.5% | 47.8% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |
| git:diff | passthrough | 2 | 7526 | 7526 | 62 | 7526 | 7584 | 99.2% | 0.8% | 99.2% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |
| git:log | passthrough | 2 | 4467 | 4467 | 68 | 4467 | 4717 | 94.7% | 1.4% | 94.7% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |
| git:push | passthrough | 2 | 58 | 58 | 63 | 58 | 102 | 56.9% | 61.8% | 56.9% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |
| git:show | passthrough | 1 | 98 | 98 | rtk: not-covered | 98 | 132 | 74.2% | rtk: not-covered | 74.2% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| git:status | active | 2 | 153 | 79 | 54 | 153 | 83 | 95.2% | 65.1% | 0% | 60.5/75% | 100% | 60.5/75% | 50% | 100% | 100% |
| vitest:run | active | 6 | 51368 | 654 | 208 | 51060 | 442 | 99.6% | 47.1% | 0.6% | 58.8/100% | 100% | 70/100% | 100% | 100% | 83.3% |

Aggregate oracle ceiling: raw 66174 tokens (0% capture), rsp 13953 tokens (99.8% capture), RTK 646 tokens (4.9% capture), Headroom 64367 tokens (0.6% capture), oracle 13874 tokens.

Large-output filters: cat:file, git:diff, git:log, vitest:run.

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | pass | 100% | 100% |

| Anti-suppression audit | Level | Verdict | Note |
| --- | --- | --- | --- |
| cargo:test | brief | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| cargo:test | terse | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| cat:file | brief | audited: ok | file reads keep code outlines or bounded text plus an elision handle for original bytes; binary output passes through |
| cat:file | terse | audited: ok | file reads keep code outlines or bounded text plus an elision handle for original bytes; binary output passes through |
| gh:issue | brief | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:issue | terse | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:pr | brief | audited: justified | empty-list sentinel is deliberate; non-empty list and view fixtures keep PR row/body TOON |
| gh:pr | terse | audited: justified | empty-list sentinel is deliberate; non-empty list and view fixtures keep PR row/body TOON |
| gh:run | brief | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:run | terse | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| git:blame | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:blame | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:branch | brief | audited: ok | branch history output keeps current marker, branch names, upstreams, commits, worktrees, and subjects as compact TOON |
| git:branch | terse | audited: ok | branch history output keeps current marker, branch names, upstreams, commits, worktrees, and subjects as compact TOON |
| git:commit | brief | audited: fixed | success output now renders commit id, branch, subject, and change counts as compact TOON |
| git:commit | terse | audited: fixed | success output now renders commit id, branch, subject, and change counts as compact TOON |
| git:diff | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:diff | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:log | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:log | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:push | brief | audited: fixed | success output now renders pushed refs and remote as compact TOON; rejected pushes remain byte-intact faults |
| git:push | terse | audited: fixed | success output now renders pushed refs and remote as compact TOON; rejected pushes remain byte-intact faults |
| git:show | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:show | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:status | brief | audited: justified | clean-tree sentinel is a deliberate definitive empty state; changed-tree output keeps row TOON |
| git:status | terse | audited: justified | clean-tree sentinel is a deliberate definitive empty state; changed-tree output keeps row TOON |
| vitest:run | brief | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| vitest:run | terse | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
Headroom baseline is replayed from checked-in recorded fixtures only; headroom-ai is only installed by the explicit capture script.
External context-optimization claims are cited literature only and were not locally reproduced.
