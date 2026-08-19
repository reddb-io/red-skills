---
name: tdd
working-mode: interactive
description: Test-driven development with a red → green loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green", wants integration tests, or asks for test-first development.
---

# Test-Driven Development

<what-to-do>

**Loop rule: red before green, one slice at a time, tests only at pre-agreed seams.** One failing test, the minimum code to pass it, nothing more; repeat until every listed behaviour is covered.

The loop has no prescribed steps — pick the next uncovered behaviour, write one failing test, write the minimum code to pass it, check the cycle checklist, move on.

### Seams

A **seam** is the public boundary you test at. Agree on seams before writing the first test — no test at an unconfirmed seam. Each seam carries one behaviour per cycle.

### Hard rules — do not break these

- ❌ Do **not** write all tests first then all implementation ("horizontal slicing"). This produces tests of *imagined* behaviour, not *actual* behaviour. See `<supporting-info>` for why.
- ❌ Do **not** write more code than the current test requires. No speculative features, no anticipating the next test.
- ❌ Do **not** test private methods or mock internal collaborators. Tests must go through the public interface.
- ❌ Do **not** verify behaviour through external means (querying the database directly when an API exists, etc.).
- ❌ Do **not** write tautological assertions — expected values must come from an independent source of truth (a literal, a worked example, the spec), not by recomputing the same way the code does. `expect(add(a, b)).toBe(a + b)` always passes and can never catch a bug.
- ✅ **Do** confirm seams before writing the first test — no test at an unconfirmed seam.
- ✅ **Do** check each cycle against the per-cycle checklist before moving to the next test.
- ✅ **Do** keep tests focused on observable behaviour through public interfaces.
- ✅ **Do** use the project's domain vocabulary in test names and interface design.

### Per-cycle checklist

Before declaring a cycle done, confirm every box:

```
[ ] A reader can tell what the system does from this test alone — not how it does it
[ ] The test reaches the system only through its public interface
[ ] This test would still pass if the internal implementation were replaced entirely
[ ] No code was added beyond what this test required
[ ] No features were anticipated beyond the current test
[ ] Expected values come from a literal, worked example, or spec — not recomputed the way the code computes them
```

If any box is unchecked, the cycle isn't done — fix it before moving on.

Once all tests are GREEN, refactoring is a separate concern — run `/code-review` on the branch to clean up.

</what-to-do>

<supporting-info>

## Philosophy

**Core principle**: Tests verify behaviour through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe *what* the system does, not *how*. A good test reads like a specification — *"user can checkout with valid cart"* tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Implementation-coupled tests** are the first bad-test pattern: they mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behaviour hasn't changed.

**Tautological tests** are the second bad-test pattern: a test whose assertion is recomputed the way the code computes it passes by construction and proves nothing. `expect(add(a, b)).toBe(a + b)` will always pass regardless of what `add` does — the assertion restates the implementation instead of verifying it against an independent expected value. Expected values must come from a literal, a worked example, or the spec.

See [tests.md](tests.md) for examples of both anti-patterns, [mocking.md](mocking.md) for mocking guidelines, [interface-design.md](interface-design.md) for designing for testability.

## Seams

A **seam** is the public boundary you test at: the interface where you observe behaviour without reaching inside the implementation. Tests live at seams, never against internals.

Confirming seams before the first test is how testing effort lands on critical paths and complex logic — not on every edge case. One seam, one test, one implementation per cycle.

## Why horizontal slicing is forbidden

Treating RED as "write all tests" and GREEN as "write all code" produces **crap tests**:

- Tests written in bulk test *imagined* behaviour, not *actual* behaviour
- You end up testing the *shape* of things (data structures, signatures) rather than user-facing behaviour
- Tests become insensitive to real changes — they pass when behaviour breaks, fail when behaviour is fine
- You outrun your headlights, committing to test structure before understanding the implementation

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  …
```

Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behaviour matters and how to verify it.

## Planning aids

When listing behaviours, also identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation) and design interfaces for [testability](interface-design.md). These choices are easier to make before any code exists.

</supporting-info>
