import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorkerIdsFromLog,
  parkedSlotWorkFor,
  slotLogPath,
} from "../src/runtime/supervisor-fs.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-sup-fs-"));
}

// ---------- parseWorkerIdsFromLog ----------

describe("parseWorkerIdsFromLog", () => {
  it("returns [] for a missing file", () => {
    expect(parseWorkerIdsFromLog("/no/such/file.log")).toEqual([]);
  });

  it("extracts a single worker ID from a boot-stamp line", () => {
    const tmp = scratch();
    try {
      const p = join(tmp, "slot-0.log");
      writeFileSync(p, "[afk] worker: wAAAA\n", "utf8");
      expect(parseWorkerIdsFromLog(p)).toEqual(["wAAAA"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("deduplicates IDs appearing on multiple lines (same worker respawned in slot)", () => {
    const tmp = scratch();
    try {
      const p = join(tmp, "slot-0.log");
      writeFileSync(p, "[afk] worker: wAAAA\nsome other output\n[afk] worker: wAAAA\n", "utf8");
      expect(parseWorkerIdsFromLog(p)).toEqual(["wAAAA"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves first-seen order for multiple distinct workers", () => {
    const tmp = scratch();
    try {
      const p = join(tmp, "slot-0.log");
      writeFileSync(p, "[afk] worker: wAAAA\n[afk] worker: wBBBB\n", "utf8");
      expect(parseWorkerIdsFromLog(p)).toEqual(["wAAAA", "wBBBB"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores lines that do not match the exact boot-stamp format", () => {
    const tmp = scratch();
    try {
      const p = join(tmp, "slot-0.log");
      writeFileSync(
        p,
        "starting worker wXXXX\n[afk] worker:wYYYY\n[afk] worker: wZZZZ extra\n[afk] worker: wAAAA\n",
        "utf8",
      );
      expect(parseWorkerIdsFromLog(p)).toEqual(["wAAAA"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- parkedSlotWorkFor — the REAL path exercised end-to-end ----------

describe("parkedSlotWorkFor (real fs — not a fake)", () => {
  it("returns empty workers when no slot log exists", () => {
    const tmp = scratch();
    try {
      const work = parkedSlotWorkFor(tmp, tmp, 0);
      expect(work.workers).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves worker ID + claimed issue from slot log + afk.state.json", () => {
    const tmp = scratch();
    try {
      // Write the per-slot log with a worker boot-stamp (the native supervisor
      // now writes this via spawnSlot's per-slot logFd).
      writeFileSync(slotLogPath(tmp, 0), "[afk] worker: wAAAA\n", "utf8");

      // Worker dir + iter dir + state file (as a live worker would leave them).
      const iterDir = join(tmp, "workers", "wAAAA", "42-a1");
      mkdirSync(iterDir, { recursive: true });
      writeFileSync(
        join(iterDir, "afk.state.json"),
        JSON.stringify({ current: { number: 42 } }),
        "utf8",
      );

      const work = parkedSlotWorkFor(tmp, tmp, 0);
      expect(work.workers).toHaveLength(1);
      expect(work.workers[0]!.workerId).toBe("wAAAA");
      expect(work.workers[0]!.pairs).toHaveLength(1);
      expect(work.workers[0]!.pairs[0]!.issue).toBe(42);
      expect(work.workers[0]!.pairs[0]!.dir).toBe(iterDir);
      expect(work.supervisorLogPath).toContain("afk-supervisor.log");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles a pre-claim worker (no afk.state.json → issue null)", () => {
    const tmp = scratch();
    try {
      writeFileSync(slotLogPath(tmp, 1), "[afk] worker: wBBBB\n", "utf8");
      const iterDir = join(tmp, "workers", "wBBBB", "7-a1");
      mkdirSync(iterDir, { recursive: true });
      // No afk.state.json — worker died before claiming.

      const work = parkedSlotWorkFor(tmp, tmp, 1);
      expect(work.workers).toHaveLength(1);
      expect(work.workers[0]!.pairs[0]!.issue).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("collects multiple workers that ran in the same slot over successive fast deaths", () => {
    const tmp = scratch();
    try {
      // Two distinct workers ran in slot 0 (K fast deaths → K workers logged).
      writeFileSync(
        slotLogPath(tmp, 0),
        "[afk] worker: wCCCC\n[afk] worker: wDDDD\n",
        "utf8",
      );

      const ccDir = join(tmp, "workers", "wCCCC", "10-a1");
      mkdirSync(ccDir, { recursive: true });
      writeFileSync(
        join(ccDir, "afk.state.json"),
        JSON.stringify({ current: { number: 10 } }),
        "utf8",
      );

      const ddDir = join(tmp, "workers", "wDDDD", "11-a1");
      mkdirSync(ddDir, { recursive: true });
      writeFileSync(
        join(ddDir, "afk.state.json"),
        JSON.stringify({ current: { number: 11 } }),
        "utf8",
      );

      const work = parkedSlotWorkFor(tmp, tmp, 0);
      expect(work.workers).toHaveLength(2);
      const wids = work.workers.map((w) => w.workerId);
      expect(wids).toContain("wCCCC");
      expect(wids).toContain("wDDDD");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("slot index is independent — slot 0 and slot 1 read from separate log files", () => {
    const tmp = scratch();
    try {
      writeFileSync(slotLogPath(tmp, 0), "[afk] worker: wEEEE\n", "utf8");
      writeFileSync(slotLogPath(tmp, 1), "[afk] worker: wFFFF\n", "utf8");

      const work0 = parkedSlotWorkFor(tmp, tmp, 0);
      const work1 = parkedSlotWorkFor(tmp, tmp, 1);
      expect(work0.workers.map((w) => w.workerId)).toEqual(["wEEEE"]);
      expect(work1.workers.map((w) => w.workerId)).toEqual(["wFFFF"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
