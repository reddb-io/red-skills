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

  it("recomputes (never throws) when readMemo throws — the codex first-tick / no-memo case", async () => {
    // The real writer's readMemo is `decodeLocMemoSnapshot(readFileSync(path))`,
    // which throws ENOENT on the ALWAYS-absent first-tick memo (and a codex
    // worker never commits, so it has no memo at all). An uncaught throw here
    // propagated out of the heartbeat's async body BEFORE it stamped loc — the
    // permanent codex `+0 -0`. resolveAttemptLoc must treat a throwing memo read
    // as a miss and recompute.
    let computeCalls = 0;
    const result = await resolveAttemptLoc({
      headSha: "sha-first-tick",
      compute: async () => {
        computeCalls += 1;
        return { added: 7, removed: 4 };
      },
      computeUncommitted: async () => ({ added: 3, removed: 0 }),
      readMemo: () => {
        throw new Error("ENOENT: no such file or directory, open '.loc-memo.json'");
      },
      writeMemo: () => {},
    });
    // committed (7/4) + uncommitted (3/0) — it recomputed rather than dying.
    expect(result).toEqual({ added: 10, removed: 4 });
    expect(computeCalls).toBe(1);
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
    const stored: LocMemo[] = [];
    const result = await resolveAttemptLoc({
      headSha: "codexsha1",
      compute: async () => ({ added: 123, removed: 7 }),
      readMemo: () => stored[0] ?? null,
      writeMemo: (m) => {
        stored[0] = m;
      },
    });
    expect(result).toEqual({ added: 123, removed: 7 });
    expect(stored[0]?.added).toBe(123);
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

  // #1224 Part A: a codex worker never commits, so its HEAD sha is frozen for the
  // whole attempt. The committed delta stays sha-memoized (0/0) while the
  // uncommitted working-tree delta is recomputed EVERY tick and added on top — so
  // the LOC counter reflects total work even with zero commits.
  it("adds the uncommitted working-tree delta on top of the memoized committed delta", async () => {
    let committedCalls = 0;
    let uncommittedCalls = 0;
    let uncommitted = { added: 0, removed: 0 };
    let stored: LocMemo | null = null;
    const deps = () => ({
      headSha: "frozensha", // never advances — codex does not commit
      compute: async () => {
        committedCalls += 1;
        return { added: 0, removed: 0 }; // no commits → committed delta is 0/0
      },
      computeUncommitted: async () => {
        uncommittedCalls += 1;
        return uncommitted;
      },
      readMemo: () => stored,
      writeMemo: (m: LocMemo) => {
        stored = m;
      },
    });

    // First tick: worktree still empty.
    const first = await resolveAttemptLoc(deps());
    expect(first).toEqual({ added: 0, removed: 0 });

    // Later tick: codex has written 120 uncommitted lines. HEAD sha unchanged, so
    // the committed memo is a HIT (no recompute), but the uncommitted delta is
    // recomputed and surfaces the work: +120, not the frozen +0.
    uncommitted = { added: 120, removed: 4 };
    const second = await resolveAttemptLoc(deps());
    expect(second).toEqual({ added: 120, removed: 4 });

    // Committed side computed at most once (memo hit on the frozen sha); the
    // uncommitted side ran on every call.
    expect(committedCalls).toBe(1);
    expect(uncommittedCalls).toBe(2);
  });

  it("recomputes committed LOC exactly once per distinct HEAD while uncommitted stays per tick", async () => {
    let headSha = "boot-base";
    let stored: LocMemo | null = null;
    let uncommitted = { added: 3, removed: 0 };
    const committedCalls: string[] = [];
    let uncommittedCalls = 0;
    const committedByHead = new Map([
      ["boot-base", { added: 0, removed: 0 }],
      ["moved-head", { added: 1222, removed: 48 }],
    ]);
    const deps = () => ({
      headSha,
      compute: async () => {
        committedCalls.push(headSha);
        return committedByHead.get(headSha) ?? { added: 0, removed: 0 };
      },
      computeUncommitted: async () => {
        uncommittedCalls += 1;
        return uncommitted;
      },
      readMemo: () => stored,
      writeMemo: (m: LocMemo) => {
        stored = m;
      },
    });

    await expect(resolveAttemptLoc(deps())).resolves.toEqual({ added: 3, removed: 0 });
    uncommitted = { added: 5, removed: 1 };
    await expect(resolveAttemptLoc(deps())).resolves.toEqual({ added: 5, removed: 1 });

    headSha = "moved-head";
    uncommitted = { added: 0, removed: 0 };
    await expect(resolveAttemptLoc(deps())).resolves.toEqual({ added: 1222, removed: 48 });
    await expect(resolveAttemptLoc(deps())).resolves.toEqual({ added: 1222, removed: 48 });

    expect(committedCalls).toEqual(["boot-base", "moved-head"]);
    expect(uncommittedCalls).toBe(4);
    expect(stored).toEqual({ sha: "moved-head", added: 1222, removed: 48 });
  });

  it("keeps the claude incremental-commit path correct: committed memo + uncommitted delta sum", async () => {
    // A claude worker commits incrementally. After a commit the committed delta is
    // sha-memoized; any not-yet-committed edits add on top of it.
    let stored: LocMemo | null = { sha: "commitA", added: 50, removed: 2 };
    const result = await resolveAttemptLoc({
      headSha: "commitA", // memo hit — committed volume served without recompute
      compute: async () => {
        throw new Error("committed compute must not run on a memo hit");
      },
      computeUncommitted: async () => ({ added: 7, removed: 1 }), // uncommitted WIP
      readMemo: () => stored,
      writeMemo: (m) => {
        stored = m;
      },
    });
    expect(result).toEqual({ added: 57, removed: 3 });
  });

  it("omitting computeUncommitted preserves the legacy committed-only behaviour", async () => {
    let stored: LocMemo | null = null;
    const result = await resolveAttemptLoc({
      headSha: "sha1",
      compute: async () => ({ added: 9, removed: 0 }),
      readMemo: () => stored,
      writeMemo: (m) => {
        stored = m;
      },
    });
    expect(result).toEqual({ added: 9, removed: 0 });
  });
});
