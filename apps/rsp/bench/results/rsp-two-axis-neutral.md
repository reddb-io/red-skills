rsp two-axis benchmark: 5 fixtures across 5 filters
Corpus: neutral-third-party

Corpus provenance:
- Public run metadata from vitest-dev/vitest Actions run 29274168273 and rust-lang/cargo Actions run 29195830177.
- Git machine output from public nodejs/node and rust-lang/rust repository history captured on 2026-07-13.
- Cargo JSON message output follows the published --message-format=json contract with third-party crate-style test names.

Production mode uses admission threshold 60%; passthrough filters count as 0% token delta because rsp returns the original command output.

| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | Headroom tokens | oracle tokens | rsp capture | RTK capture | Headroom capture | brief shipped delta | brief fidelity-first score | terse shipped delta | terse fidelity-first score | RTK fidelity-first score | Headroom fidelity-first score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cargo:test | passthrough | 1 | 223 | 223 | 37 | 95 | 79 | 0% | 46.8% | 88.9% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |
| gh:run | passthrough | 1 | 136 | 136 | rtk: not-covered | 136 | 119 | 0% | rtk: not-covered | 0% | 0/0% | 100% | 0/0% | 100% | rtk: not-covered | 100% |
| git:commit | passthrough | 1 | 33 | 33 | 28 | 33 | 68 | 48.5% | 41.2% | 48.5% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |
| git:diff | active | 1 | 326 | 378 | 34 | 326 | 378 | 100% | 9% | 86.2% | -16/-16% | 100% | 78.8/78.8% | 0% | 100% | 100% |
| git:log | passthrough | 1 | 151 | 151 | 28 | 151 | 176 | 85.8% | 15.9% | 85.8% | 0/0% | 100% | 0/0% | 100% | 100% | 100% |

Aggregate oracle ceiling: raw 869 tokens (0% capture), rsp 921 tokens (0% capture), RTK 127 tokens (18.1% capture), Headroom 741 tokens (90.4% capture), oracle 820 tokens.

Large-output filters: git:diff.

| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |
| --- | --- | --- | ---: | ---: |
| cargo-test | cargo:test | fail | 100% | 100% |
| git-commit | git:commit | fail | 100% | 100% |

| Anti-suppression audit | Level | Verdict | Note |
| --- | --- | --- | --- |
| cargo:test | brief | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| cargo:test | terse | audited: ok | test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail |
| gh:run | brief | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| gh:run | terse | audited: ok | successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough |
| git:commit | brief | audited: fixed | success output now renders commit id, branch, subject, and change counts as compact TOON |
| git:commit | terse | audited: fixed | success output now renders commit id, branch, subject, and change counts as compact TOON |
| git:diff | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:diff | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:log | brief | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |
| git:log | terse | audited: ok | large row sets keep compact TOON plus an elision handle for full detail |

RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.
Headroom baseline is replayed from checked-in recorded fixtures only; headroom-ai is only installed by the explicit capture script.
External context-optimization claims are cited literature only and were not locally reproduced.
