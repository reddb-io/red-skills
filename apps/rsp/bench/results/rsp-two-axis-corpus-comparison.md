# rsp Two-Axis Corpus Comparison

Generated from the checked-in home corpus and the additive neutral third-party corpus.

| Corpus | Fixtures | Filters | raw tokens | rsp tokens | RTK tokens | Headroom tokens | oracle tokens | rsp capture | RTK capture | Headroom capture |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| home | 31 | 14 | 66174 | 13953 | 646 | 64367 | 13874 | 99.8% | 4.9% | 0.6% |
| neutral-third-party | 5 | 5 | 869 | 921 | 127 | 741 | 820 | 0% | 18.1% | 90.4% |

Neutral-corpus provenance is recorded in
`apps/rsp/bench/results/rsp-two-axis-neutral.md` and
`apps/rsp/bench/results/rsp-two-axis-neutral.toon`.

Decision-usefulness-first reading: a token reduction with failed fidelity is not
a useful win. The per-filter result tables keep token movement and fidelity
visible together so suppression-only output cannot outrank preserved decision
facts.
