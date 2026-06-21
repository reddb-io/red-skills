---
name: tdd
description: Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development.
---

# Test-Driven Development

<what-to-do>

**Build one vertical slice at a time — RED then GREEN, never the reverse, never in bulk.** One failing test, the minimum code to pass it, nothing more; repeat until every listed behaviour is covered, then refactor.

Build the feature one **vertical slice** at a time. Each slice is exactly one RED → GREEN cycle: one failing test, then the minimum code to pass it. Repeat until the listed behaviours are covered, then refactor.

### Step 1 — Plan, then get approval

Before writing any code or test:

1. Explore the codebase. Use the project's domain glossary so test names and interface vocabulary match the project's language. Respect ADRs in the area you're touching.
2. List the **behaviours** to test (not implementation steps). Prioritise: critical paths and complex logic first; you cannot test everything.
3. Ask the user: *"What should the public interface look like? Which behaviours matter most?"*
4. Present the plan. **Get explicit user approval before writing the first test.**

### Step 2 — Tracer bullet (first cycle)

Write **ONE** test that confirms **ONE** thing end-to-end:

```
RED:   Write the test → watch it fail
GREEN: Write the minimum code to pass → watch it pass
```

This proves the path works through every layer.

### Step 3 — Incremental loop (every cycle after the tracer)

For each remaining behaviour, repeat:

```
RED:   Write the next test → fails
GREEN: Minimum code to pass → passes
```

### Step 4 — Refactor (only after GREEN)

Once all planned tests are GREEN:

- Extract duplication
- Deepen modules (move complexity behind simple interfaces) — see [deep-modules.md](deep-modules.md)
- Apply SOLID where it falls out naturally
- Run the full test suite after **each** refactor step
- See [refactoring.md](refactoring.md) for candidates

### Hard rules — do not break these

- ❌ Do **not** write all tests first then all implementation ("horizontal slicing"). This produces tests of *imagined* behaviour, not *actual* behaviour. See `<supporting-info>` for why.
- ❌ Do **not** refactor while RED. Get to GREEN first.
- ❌ Do **not** write more code than the current test requires. No speculative features, no anticipating the next test.
- ❌ Do **not** test private methods or mock internal collaborators. Tests must go through the public interface.
- ❌ Do **not** verify behaviour through external means (querying the database directly when an API exists, etc.).
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
```

If any box is unchecked, the cycle isn't done — fix it before moving on.

</what-to-do>

<supporting-info>

## Philosophy

**Core principle**: Tests verify behaviour through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe *what* the system does, not *how*. A good test reads like a specification — *"user can checkout with valid cart"* tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behaviour hasn't changed.

See [tests.md](tests.md) for examples, [mocking.md](mocking.md) for mocking guidelines, [interface-design.md](interface-design.md) for designing for testability.

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

When listing behaviours in Step 1, also identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation) and design interfaces for [testability](interface-design.md). These choices are easier to make before any code exists.

</supporting-info>
