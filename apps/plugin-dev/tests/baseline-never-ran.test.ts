// "Also fails on the baseline" is a claim about a comparison (#3126).
//
// #3082 sat parked as broken work for hours on a validation record that read
// `failed` in 146 milliseconds — no test ran — with `typecheck` and `build`
// green. Its summary said "inconclusive: also fails on the baseline — ENOENT:
// no such file or directory, lstat '.../feedback/main'".
//
// The baseline worktree did not exist. Nothing was compared. The change was
// complete and landed unmodified once rebased.
//
// Blocking on a genuinely inconclusive result is deliberate (#2380): the probe
// downgrades nothing, because pre-merge gating is the sole quality gate. This
// is about the OTHER case — asserting a comparison that never happened.
import { describe, expect, it } from "vitest";
import { baselineNeverRan } from "../src/core/feedback.js";

describe("baselineNeverRan", () => {
  it("recognises the exact message that parked #3082", () => {
    expect(
      baselineNeverRan("ENOENT: no such file or directory, lstat '/w/.red/tmp/worktrees/feedback/main'"),
    ).toBe(true);
  });

  it("recognises the other harness failures seen in the same logs", () => {
    for (const message of [
      "feedback worktree add failed for main; fatal: couldn't find remote ref refs/heads/main",
      "feedback worktree install failed for afk/w1/42-fix (exit 1)",
      "fatal: unable to lock ref",
      "feedback worktree /root/.red/tmp/feedback/afk-w1-9-x is busy (lock wait timed out)",
      "EACCES: permission denied",
    ]) {
      expect(baselineNeverRan(message), message).toBe(true);
    }
  });

  it("does NOT claim a real reproduced failure was a harness fault", () => {
    // These are genuine inconclusive results: the baseline ran and also failed.
    // Blocking on them is the documented behaviour and must not change.
    for (const message of [
      "2 tests failed",
      "command exited 1",
      "AssertionError: expected 1 to be 2",
      "Test Files 1 failed | 8 passed",
    ]) {
      expect(baselineNeverRan(message), message).toBe(false);
    }
  });

  it("is false for an absent or empty summary rather than guessing", () => {
    expect(baselineNeverRan(undefined)).toBe(false);
    expect(baselineNeverRan("")).toBe(false);
    expect(baselineNeverRan("   ")).toBe(false);
  });
});
