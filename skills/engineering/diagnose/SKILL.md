---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test. Use when user says "diagnose this" / "debug this", reports a bug, says something is broken/throwing/failing, or describes a performance regression.
---

# Diagnose

A discipline for hard bugs. Execute the phases in order. Skip a phase **only** when you can name an explicit reason and the user agrees.

<what-to-do>

When exploring the codebase, use the project's domain glossary to get a clear mental model of the relevant modules, and check ADRs in the area you're touching.

### Phase 1 — Build a feedback loop

**This is the skill.** Do not move on without one. A fast, deterministic, agent-runnable pass/fail signal makes every later phase mechanical. Without one, no amount of staring at code will save you.

**Be aggressive. Be creative. Refuse to give up.** Spend disproportionate effort here.

Try the 10 construction strategies in `<supporting-info>` in roughly that order. Once you have a loop, **iterate on it as a product**:

- Make it faster (cache setup, narrow scope)
- Make the signal sharper (assert on the specific symptom, not "didn't crash")
- Make it deterministic (pin time, seed RNG, isolate filesystem, freeze network)

For **non-deterministic** bugs the goal is a **higher reproduction rate**, not a clean repro. Loop the trigger 100×, parallelise, add stress, narrow timing windows. 50% flake is debuggable; 1% is not.

**Do not proceed to Phase 2 until you have a loop you believe in.** If you genuinely cannot build one, stop and tell the user what you tried; ask for environment access, a captured artifact, or permission to add temporary production instrumentation.

### Phase 2 — Reproduce

Run the loop. Watch the bug appear. Confirm all three:

- [ ] The loop produces the failure mode the **user** described — not a different failure that happens to be nearby
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, at a high enough rate to debug against)
- [ ] You captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix addresses it

**Do not proceed until you reproduce the bug.**

### Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis **must be falsifiable**:

> Format: *"If &lt;X&gt; is the cause, then &lt;changing Y&gt; will make the bug disappear / &lt;changing Z&gt; will make it worse."*

If you can't state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3") or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it if the user is AFK — proceed with your ranking.

### Phase 4 — Instrument

Each probe maps to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference, in order:

1. Debugger / REPL inspection if the env supports it — one breakpoint beats ten logs
2. Targeted logs at the boundaries that distinguish hypotheses
3. Never "log everything and grep"

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

### Phase 5 — Fix + regression test

Write the regression test **before the fix** — but only if a **correct seam** exists. A correct seam exercises the **real bug pattern** as it occurs at the call site. A too-shallow seam (single-caller unit test when the bug needs the multi-caller chain) gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it explicitly. The codebase architecture is preventing the bug from being locked down — flag for Phase 6.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam
2. Watch it fail
3. Apply the fix
4. Watch it pass
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario

### Phase 6 — Cleanup + post-mortem

Required before declaring done — every box:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The hypothesis that turned out correct is stated in the commit / PR message — so the next debugger learns

**Then ask: what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling), hand off to `/improve-codebase-architecture` with the specifics. Make the recommendation **after** the fix is in, not before — you have more information now than when you started.

### Hard rules — apply across phases

- ❌ Do **not** start hypothesising without a feedback loop (Phase 1 must close first)
- ❌ Do **not** apply a fix before reproducing the bug
- ❌ Do **not** change more than one variable per probe in Phase 4
- ❌ Do **not** leave `[DEBUG-...]` instrumentation in the final diff
- ❌ Do **not** declare done without re-running the Phase 1 loop against the original scenario
- ✅ **Do** state explicitly when you're skipping a phase and why

</what-to-do>

<supporting-info>

## Ten ways to construct a feedback loop (Phase 1)

Try in roughly this order. Stop at the first one that gives you a fast, deterministic pass/fail signal.

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e
2. **Curl / HTTP script** against a running dev server
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM/console/network
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay through the code path in isolation
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug with a single function call
7. **Property / fuzz loop.** If "sometimes wrong output", run 1000 random inputs and look for the failure mode
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate `boot at state X, check, repeat` so you can `git bisect run` it
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs
10. **HITL bash script.** Last resort. If a human must click, drive *them* with `scripts/hitl-loop.template.sh` so the loop is still structured. Captured output feeds back to you

Build the right feedback loop and the bug is 90% fixed.

## Loop quality reminder

A 30-second flaky loop is barely better than no loop. A 2-second deterministic loop is a debugging superpower.

## When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for one of:

- (a) Access to whatever environment reproduces it
- (b) A captured artifact (HAR file, log dump, core dump, screen recording with timestamps)
- (c) Permission to add temporary production instrumentation

Do **not** proceed to hypothesise without a loop.

</supporting-info>
