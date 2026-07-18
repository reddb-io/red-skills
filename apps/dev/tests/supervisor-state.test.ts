import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reapDeadSupervisorSnapshotDirs } from "../src/runtime/supervisor-state.js";

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
