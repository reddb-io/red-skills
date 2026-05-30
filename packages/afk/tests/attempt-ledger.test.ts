import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  attemptLedgerContext,
  attemptLedgerNextNumber,
  attemptLedgerPrevDir,
  formatAttemptContext,
  highestAttempt,
  type AttemptDirEntry,
} from "../src/core/attempt-ledger.js";

interface MakeAttempt {
  worker: string;
  issue: number;
  attempt: number;
  branch?: string;
  reason?: string;
}

async function mkAttempt(root: string, { worker, issue, attempt, branch, reason }: MakeAttempt): Promise<void> {
  const dir = join(root, "workers", worker, `${issue}-a${attempt}`);
  await mkdir(join(dir, "worktree"), { recursive: true });
  if (branch !== undefined) await writeFile(join(dir, "snapshot-branch.ref"), `${branch}\n`, "utf8");
  if (reason !== undefined) await writeFile(join(dir, "failure.reason"), `${reason}\n`, "utf8");
}

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "afk-attempt-ledger-"));
}

describe("attempt-ledger numbering (pure core)", () => {
  const entries = (records: AttemptDirEntry[]): AttemptDirEntry[] => records;

  it("returns null when no worker has a matching attempt dir", () => {
    expect(highestAttempt("/r", 249, entries([{ worker: "wA1B9", basenames: [] }]))).toBeNull();
  });

  it("picks the numeric max across workers, not the lexical max", () => {
    const best = highestAttempt(
      "/r",
      249,
      entries([
        { worker: "wA1B9", basenames: ["249-a1", "249-a2"] },
        { worker: "wC7D2", basenames: ["249-a10", "249-a3"] },
      ]),
    );
    expect(best).toEqual({ attempt: 10, dir: "/r/workers/wC7D2/249-a10" });
  });

  it("ignores other issues and non-numeric attempt suffixes", () => {
    const best = highestAttempt(
      "/r",
      249,
      entries([
        { worker: "wA1B9", basenames: ["250-a4", "249-aX", "249-a2"] },
        { worker: "wZZZ", basenames: ["worktree", "249-a01"] },
      ]),
    );
    expect(best).toEqual({ attempt: 2, dir: "/r/workers/wA1B9/249-a2" });
  });
});

describe("attempt-ledger next number (FS-backed)", () => {
  it("derives 1 for an issue with no directories", async () => {
    const root = await tmpRoot();
    expect(await attemptLedgerNextNumber(root, 249)).toBe(1);
  });

  it("derives max+1 across workers, numeric not lexical, independent per issue", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wA1B9", issue: 249, attempt: 1, branch: "afk-attempts/wA1B9/249-foo", reason: "BLOCKED: typecheck failed" });
    expect(await attemptLedgerNextNumber(root, 249)).toBe(2);

    await mkAttempt(root, { worker: "wA1B9", issue: 249, attempt: 2, reason: "no-sentinel" });
    await mkAttempt(root, { worker: "wC7D2", issue: 249, attempt: 10, reason: "stall-reaped", branch: "afk-attempts/wC7D2/249-foo" });
    await mkAttempt(root, { worker: "wC7D2", issue: 249, attempt: 3, reason: "BLOCKED" });
    expect(await attemptLedgerNextNumber(root, 249)).toBe(11);

    await mkAttempt(root, { worker: "wA1B9", issue: 250, attempt: 4, reason: "fail" });
    expect(await attemptLedgerNextNumber(root, 250)).toBe(5);
    expect(await attemptLedgerNextNumber(root, 249)).toBe(11);
    expect(await attemptLedgerNextNumber(root, 999)).toBe(1);
  });

  it("ignores junk dirs that match the shell glob but not the attempt scheme", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wC7D2", issue: 249, attempt: 10 });
    await mkdir(join(root, "workers", "wZZZ", "249-aX"), { recursive: true });
    expect(await attemptLedgerNextNumber(root, 249)).toBe(11);
  });

  it("rejects a malformed issue identity", async () => {
    const root = await tmpRoot();
    await expect(attemptLedgerNextNumber(root, 0)).rejects.toThrow(/invalid issue/);
    await expect(attemptLedgerNextNumber("", 249)).rejects.toThrow(/root is required/);
  });
});

describe("attempt-ledger prev dir", () => {
  it("returns the highest-numbered attempt directory", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wA1B9", issue: 249, attempt: 2 });
    await mkAttempt(root, { worker: "wC7D2", issue: 249, attempt: 10 });
    expect(await attemptLedgerPrevDir(root, 249)).toBe(join(root, "workers", "wC7D2", "249-a10"));
  });

  it("returns null for an issue with no prior attempt", async () => {
    const root = await tmpRoot();
    expect(await attemptLedgerPrevDir(root, 999)).toBeNull();
  });
});

describe("attempt-ledger restart context", () => {
  it("carries the previous attempt number, branch ref, and failure reason", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wC7D2", issue: 249, attempt: 10, branch: "afk-attempts/wC7D2/249-foo", reason: "stall-reaped" });
    const context = await attemptLedgerContext(root, 249);
    expect(context).not.toBeNull();
    expect(context?.prevAttempt).toBe(10);
    expect(context?.prevSnapshotBranch).toBe("afk-attempts/wC7D2/249-foo");
    expect(context?.prevFailureReason).toContain("stall-reaped");
    expect(formatAttemptContext(context!)).toContain("prev-snapshot-branch: afk-attempts/wC7D2/249-foo");
  });

  it("returns null on the first attempt (nothing to restart from)", async () => {
    const root = await tmpRoot();
    expect(await attemptLedgerContext(root, 998)).toBeNull();
  });

  it("labels missing marker files instead of failing", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wE5F6", issue: 777, attempt: 1 });
    const context = await attemptLedgerContext(root, 777);
    expect(context?.prevAttempt).toBe(1);
    expect(context?.prevSnapshotBranch).toBe("(none)");
    expect(context?.prevFailureReason).toBe("(none recorded)");
  });

  it("keeps the branch but labels a missing reason on a partial attempt", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wG7H8", issue: 778, attempt: 1, branch: "afk-attempts/wG7H8/778-baz" });
    const context = await attemptLedgerContext(root, 778);
    expect(context?.prevSnapshotBranch).toBe("afk-attempts/wG7H8/778-baz");
    expect(context?.prevFailureReason).toBe("(none recorded)");
  });

  it("preserves multi-line failure reasons verbatim", async () => {
    const root = await tmpRoot();
    await mkAttempt(root, { worker: "wI9J0", issue: 779, attempt: 1, branch: "afk-attempts/wI9J0/779-qux", reason: "line one\nline two" });
    const context = await attemptLedgerContext(root, 779);
    expect(context?.prevFailureReason).toContain("line one");
    expect(context?.prevFailureReason).toContain("line two");
  });
});
