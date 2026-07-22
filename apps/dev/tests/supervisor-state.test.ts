import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverLiveSupervisorPid,
  isSupervisorIdentityLive,
  reapDeadSupervisorSnapshotDirs,
  reapStaleSupervisorState,
} from "../src/runtime/supervisor-state.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-supervisor-state-"));
}

describe("reapDeadSupervisorSnapshotDirs", () => {
  it("removes dead s<PID> supervisor snapshot dirs and preserves live/current dirs", async () => {
    const root = scratch();
    try {
      const supervisors = join(root, ".red", "state", "castle", "supervisors");
      const dead = join(supervisors, "s111");
      const live = join(supervisors, "s222");
      const current = join(supervisors, "s333");
      const named = join(supervisors, "default");
      for (const dir of [dead, live, current, named]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "state.toon"), "state\n", "utf8");
      }

      const removed = await reapDeadSupervisorSnapshotDirs(
        supervisors,
        (pid) => pid === 222,
        333,
      );

      expect(removed).toEqual([dead]);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(current)).toBe(true);
      expect(existsSync(named)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pinned supervisor identity", () => {
  it("fails closed when the process-start pin is missing", () => {
    expect(isSupervisorIdentityLive({ pid: 4242, startTime: "" }, () => true, () => "live-start"))
      .toBe(false);
  });

  it("rejects a recycled pid in discovery and reaps its stale state", async () => {
    const root = scratch();
    try {
      const runtime = join(root, ".red", "tmp", "supervisors", "default");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "afk-supervisor.pid"), "4242", "utf8");
      writeFileSync(join(runtime, "afk-supervisor.pid.start"), "recorded-start", "utf8");
      mkdirSync(join(runtime, "s4242"), { recursive: true });

      const pidStartTime = () => "recycled-start";
      expect(
        await discoverLiveSupervisorPid(runtime, () => true, { pidStartTime }),
      ).toBeNull();
      expect(
        await reapStaleSupervisorState(runtime, () => true, pidStartTime),
      ).toMatchObject({ status: "stale", pid: 4242 });
      expect(existsSync(join(runtime, "afk-supervisor.pid"))).toBe(false);
      expect(existsSync(join(runtime, "afk-supervisor.pid.start"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
