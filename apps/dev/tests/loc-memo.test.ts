import { describe, expect, it } from "vitest";
import { resolveAttemptLoc, locMemoPath, type LocMemo } from "../src/core/loc-memo.js";

describe("resolveAttemptLoc — commit-anchored LOC memo (#1210)", () => {
  it("computes once per commit: a memo hit on the same sha spawns no diffstat", async () => {
    let computeCalls = 0;
    let stored: LocMemo | null = null;
    const deps = {
      headSha: "deadbeefcafe",
      compute: async () => {
        computeCalls += 1;
        return { added: 42, removed: 3 };
      },
      readMemo: () => stored,
      writeMemo: (m: LocMemo) => {
        stored = m;
      },
    };

    // First call: memo miss → computes once and persists against the sha.
    const first = await resolveAttemptLoc(deps);
    expect(first).toEqual({ added: 42, removed: 3 });
    expect(computeCalls).toBe(1);
    expect(stored).toEqual({ sha: "deadbeefcafe", added: 42, removed: 3 });

    // Second call, same HEAD: memo hit → served WITHOUT recomputing.
    const second = await resolveAttemptLoc(deps);
    expect(second).toEqual({ added: 42, removed: 3 });
    expect(computeCalls).toBe(1); // still 1 — no extra git subprocess
  });

  it("recomputes when HEAD advances (a new commit invalidates the memo)", async () => {
    let computeCalls = 0;
    let stored: LocMemo | null = { sha: "old", added: 10, removed: 1 };
    const result = await resolveAttemptLoc({
      headSha: "new",
      compute: async () => {
        computeCalls += 1;
        return { added: 88, removed: 9 }; // volume after the new commit
      },
      readMemo: () => stored,
      writeMemo: (m) => {
        stored = m;
      },
    });
    expect(result).toEqual({ added: 88, removed: 9 });
    expect(computeCalls).toBe(1);
    expect(stored).toEqual({ sha: "new", added: 88, removed: 9 });
  });

  it("is runner-agnostic: a codex-runner attempt gets its non-zero LOC stamped", async () => {
    // The memo never inspects the runner — the same path that serves claude serves
    // codex, so the historical codex 0/0 gap that forced the render fallback is
    // closed at the writer.
    let stored: LocMemo | null = null;
    const result = await resolveAttemptLoc({
      headSha: "codexsha1",
      compute: async () => ({ added: 123, removed: 7 }),
      readMemo: () => stored,
      writeMemo: (m) => {
        stored = m;
      },
    });
    expect(result).toEqual({ added: 123, removed: 7 });
    expect(stored?.added).toBe(123);
  });

  it("an empty HEAD sha never memoizes: it always recomputes", async () => {
    let computeCalls = 0;
    let stored: LocMemo | null = null;
    const deps = {
      headSha: "",
      compute: async () => {
        computeCalls += 1;
        return { added: 5, removed: 0 };
      },
      readMemo: () => stored,
      writeMemo: (m: LocMemo) => {
        stored = m;
      },
    };
    await resolveAttemptLoc(deps);
    await resolveAttemptLoc(deps);
    expect(computeCalls).toBe(2); // no memo key → recompute each time
    expect(stored).toBeNull(); // nothing persisted for an empty sha
  });

  it("locMemoPath sits beside the attempt state file", () => {
    expect(locMemoPath("/tmp/attempt")).toBe("/tmp/attempt/.loc-memo.json");
  });
});
