# rsp Two-Axis Benchmark

The rsp benchmark measures two separate questions:

1. **Decision-oracle capture**: how close the emitted output is to the
   hand-reviewed compact oracle for each fixture, measured with
   `js-tiktoken:gpt-4o` token counts.
2. **Fidelity-first behavior**: whether the emitted output still preserves the
   command facts an agent needs, such as exit status, failure rows, commit ids,
   PR rows, and recovery handles.

The headline used by the rsp docs is **99.4% decision-oracle capture** for rsp
versus **RTK 4.9%** and **Headroom 0.6%**. The generated result artifacts live
in [bench/results/rsp-two-axis.md](results/rsp-two-axis.md) and
[bench/results/rsp-two-axis.toon](results/rsp-two-axis.toon).

## Run It

From the repo root:

```sh
pnpm --filter @reddb-io/rsp bench:two-axis
```

This regenerates the default artifacts:

- `apps/rsp/bench/results/rsp-two-axis.toon`
- `apps/rsp/bench/results/rsp-two-axis.md`

To write to explicit paths:

```sh
pnpm --filter @reddb-io/rsp exec node --import tsx src/two-axis-benchmark-cli.ts \
  --out /tmp/rsp-two-axis.toon \
  --summary /tmp/rsp-two-axis.md
```

To run the checked-in regression gate:

```sh
pnpm --filter @reddb-io/rsp bench:two-axis:check
```

The check command reads the current `--out` artifact as the baseline, reruns the
benchmark, rewrites the artifacts, and fails when a current filter regresses by
more than the configured token threshold or loses fidelity. The thresholds live
in `src/two-axis-thresholds.ts`.

## Corpus

The benchmark discovers fidelity fixtures under `apps/rsp/tests/fixtures`:

- `file-read`
- `gh`
- `git`
- `test-runners`

Each fixture records raw command output and expected decision facts. Most
fixtures have an adjacent `.oracle.toon` file that represents the hand-reviewed
compact oracle. The benchmark requires large-output fixtures for git diff,
git log, vitest green output, and vitest failure output so the result continues
to cover the cases where reduction matters most.

The RTK and Headroom comparators are recorded baselines:

- `apps/rsp/tests/fixtures/rtk/baselines.json`
- `apps/rsp/tests/fixtures/headroom/baselines.json`

The benchmark does not execute RTK or Headroom during normal runs. Headroom
capture is isolated in `apps/rsp/scripts/capture-headroom-baselines.py`.

## Read the Summary

`bench/results/rsp-two-axis.md` starts with the corpus size and admission
threshold. Production mode applies the admission threshold before activating a
filter; passthrough filters count as 0% token delta because rsp returns the
original output for those command shapes.

The main table has one row per filter:

- `Mode`: whether the filter is active in production or passthrough.
- `raw tokens`: token count of recorded command output.
- `rsp tokens`: token count emitted by the production rsp mode.
- `RTK tokens` and `Headroom tokens`: recorded comparator token counts, or
  `not-covered`.
- `oracle tokens`: token count of the hand-reviewed oracle.
- `rsp capture`, `RTK capture`, `Headroom capture`: decision-oracle capture
  percentages. Higher is closer to the oracle.
- `brief shipped delta` and `terse shipped delta`: median and p90 token
  reduction for the shipped rsp modes.
- `fidelity-first score`: percentage of fixtures whose decision assertions
  still pass.

The aggregate line combines all fixtures. It is the fastest way to compare rsp,
RTK, Headroom, raw output, and the oracle ceiling.

## Read the TOON Artifact

`bench/results/rsp-two-axis.toon` is the machine-readable report. It includes:

- `method`: tokenizer, raw source, rsp source, oracle source, comparator source,
  and unverified external literature claims.
- `filters`: per-filter rows with raw/brief/terse axes, comparator axes,
  oracle-capture axes, and hypothetical active-mode results for passthrough
  filters.
- `aggregate`: corpus-wide oracle-capture counts and percentages.
- `parity`: direct fidelity gates for selected parity domains.
- `anti_suppression_audit`: notes explaining why each filter does not hide the
  decision signal.

Use the Markdown summary for human review and the TOON artifact for regression
checks or downstream analysis.
