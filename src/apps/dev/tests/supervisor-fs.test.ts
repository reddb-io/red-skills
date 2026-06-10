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
  // --- slot-log path ---

  it("returns empty workers when no slot log and no lastPid", () => {
    const tmp = scratch();
    try {
      const work = parkedSlotWorkFor(tmp, 0);
      expect(work.workers).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves worker ID + claimed issue from slot log + afk.state.json", () => {
    const tmp = scratch();
    try {
      writeFileSync(slotLogPath(tmp, 0), "[afk] worker: wAAAA\n", "utf8");

      const iterDir = join(tmp, "workers", "wAAAA", "42-a1");
      mkdirSync(iterDir, { recursive: true });
      writeFileSync(
        join(iterDir, "afk.state.json"),
        JSON.stringify({ current: { number: 42 } }),
        "utf8",
      );

      const work = parkedSlotWorkFor(tmp, 0);
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

      const work = parkedSlotWorkFor(tmp, 1);
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

      const work = parkedSlotWorkFor(tmp, 0);
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

      const work0 = parkedSlotWorkFor(tmp, 0);
      const work1 = parkedSlotWorkFor(tmp, 1);
      expect(work0.workers.map((w) => w.workerId)).toEqual(["wEEEE"]);
      expect(work1.workers.map((w) => w.workerId)).toEqual(["wFFFF"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // --- PID-based fallback path (native fleet: no boot-stamp in slot log) ---

  it("resolves worker + claimed issue from lastPid when no slot log exists", () => {
    // This is the REAL native-fleet path: the supervisor never writes the
    // [afk] worker: boot-stamp to the slot log, so the log parse returns [].
    // parkedSlotWorkFor falls back to findSlotIterDir(tmpDir, lastPid) to
    // locate the last worker via its worker.pid file.
    const tmp = scratch();
    try {
      const wid = "wPPPP";
      const pid = 99999;

      // Worker dir with worker.pid matching the slot's last known PID.
      const workerPath = join(tmp, "workers", wid);
      mkdirSync(workerPath, { recursive: true });
      writeFileSync(join(workerPath, "worker.pid"), String(pid), "utf8");

      // Iter dir with a claimed issue (as a live worker leaves it).
      const iterDir = join(workerPath, "55-a1");
      mkdirSync(iterDir, { recursive: true });
      writeFileSync(
        join(iterDir, "afk.state.json"),
        JSON.stringify({ current: { number: 55 } }),
        "utf8",
      );

      const work = parkedSlotWorkFor(tmp, 0, pid);
      expect(work.workers).toHaveLength(1);
      expect(work.workers[0]!.workerId).toBe(wid);
      expect(work.workers[0]!.pairs).toHaveLength(1);
      expect(work.workers[0]!.pairs[0]!.issue).toBe(55);
      expect(work.workers[0]!.pairs[0]!.dir).toBe(iterDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PID fallback returns pre-claim worker (no afk.state.json) with issue null", () => {
    const tmp = scratch();
    try {
      const wid = "wQQQQ";
      const pid = 11111;

      const workerPath = join(tmp, "workers", wid);
      mkdirSync(workerPath, { recursive: true });
      writeFileSync(join(workerPath, "worker.pid"), String(pid), "utf8");

      // Iter dir created but worker died before writing afk.state.json.
      const iterDir = join(workerPath, "7-a1");
      mkdirSync(iterDir, { recursive: true });

      const work = parkedSlotWorkFor(tmp, 0, pid);
      expect(work.workers).toHaveLength(1);
      expect(work.workers[0]!.workerId).toBe(wid);
      expect(work.workers[0]!.pairs[0]!.issue).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PID fallback returns empty workers when no worker.pid matches the given pid", () => {
    const tmp = scratch();
    try {
      // A worker dir exists but its worker.pid does not match the lastPid.
      const workerPath = join(tmp, "workers", "wRRRR");
      mkdirSync(workerPath, { recursive: true });
      writeFileSync(join(workerPath, "worker.pid"), "22222", "utf8");

      const work = parkedSlotWorkFor(tmp, 0, 99999);
      expect(work.workers).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PID fallback returns empty workers when lastPid is null", () => {
    const tmp = scratch();
    try {
      const work = parkedSlotWorkFor(tmp, 0, null);
      expect(work.workers).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("slot-log path takes precedence over PID fallback when log has workers", () => {
    // When the slot log has boot-stamps, use those rather than the PID path.
    const tmp = scratch();
    try {
      const logWid = "wLOGG";
      const pidWid = "wPIDD";
      const pid = 33333;

      // Slot log lists logWid.
      writeFileSync(slotLogPath(tmp, 0), `[afk] worker: ${logWid}\n`, "utf8");
      const logIterDir = join(tmp, "workers", logWid, "20-a1");
      mkdirSync(logIterDir, { recursive: true });
      writeFileSync(
        join(logIterDir, "afk.state.json"),
        JSON.stringify({ current: { number: 20 } }),
        "utf8",
      );

      // PID-matched worker also exists (should be ignored).
      const pidWorkerPath = join(tmp, "workers", pidWid);
      mkdirSync(pidWorkerPath, { recursive: true });
      writeFileSync(join(pidWorkerPath, "worker.pid"), String(pid), "utf8");
      const pidIterDir = join(pidWorkerPath, "21-a1");
      mkdirSync(pidIterDir, { recursive: true });
      writeFileSync(
        join(pidIterDir, "afk.state.json"),
        JSON.stringify({ current: { number: 21 } }),
        "utf8",
      );

      const work = parkedSlotWorkFor(tmp, 0, pid);
      // Only the log-path worker is returned.
      expect(work.workers).toHaveLength(1);
      expect(work.workers[0]!.workerId).toBe(logWid);
      expect(work.workers[0]!.pairs[0]!.issue).toBe(20);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
