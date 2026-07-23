import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  isLivePid,
  killTreeAndWait,
  signalProcessGroup,
  type KillTreeIO,
} from "../src/runtime/kill-tree.js";

// A deterministic fake of the tree-killer IO: `aliveFor` ticks of liveness, with
// each await sleep() advancing one tick. Records every signal sent so the
// escalation order (SIGTERM then SIGKILL) is asserted.
function fakeIO(opts: { aliveFor: number }): { io: KillTreeIO; signals: NodeJS.Signals[]; ticks: () => number } {
  const signals: NodeJS.Signals[] = [];
  let elapsed = 0;
  const io: KillTreeIO = {
    isAlive: () => elapsed < opts.aliveFor,
    signal: (_pid, sig) => {
      signals.push(sig);
    },
    sleep: async () => {
      elapsed += 1;
    },
  };
  return { io, signals, ticks: () => elapsed };
}

async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isLivePid(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (isLivePid(pid)) throw new Error(`process ${pid} survived tree reap`);
}

describe("killTreeAndWait", () => {
  it.skipIf(process.platform === "win32")("confirms a worker fork is gone after its group leader exits", async () => {
    const leader = spawn(
      "sh",
      ["-c", 'sh -c \'trap "" TERM; while :; do sleep 1; done\' </dev/null >/dev/null 2>&1 & child=$!; printf "%s\\n" "$child"; wait'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const childPid = await new Promise<number>((resolve) => {
      leader.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });

    try {
      expect(await killTreeAndWait(leader.pid!, { pollMs: 25, graceTries: 2, killTries: 20 })).toBe(true);
      await expect.poll(() => {
        try {
          process.kill(childPid, 0);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 2_000 }).toBe(false);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // The expected path already reaped it.
      }
    }
  });

  it("SIGTERMs and returns dead WITHOUT escalating when the tree exits in the grace window", async () => {
    // Dies after 3 grace polls — well under the 20-tick grace.
    const { io, signals } = fakeIO({ aliveFor: 3 });

    const dead = await killTreeAndWait(123, { io });

    expect(dead).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    expect(signals).not.toContain("SIGKILL");
  });

  it("escalates to SIGKILL after the grace, then confirms exit", async () => {
    // Survives the full 20-tick grace, dies during the SIGKILL confirm window.
    const { io, signals } = fakeIO({ aliveFor: 24 });

    const dead = await killTreeAndWait(123, { io });

    expect(dead).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    // SIGTERM precedes SIGKILL.
    expect(signals.indexOf("SIGTERM")).toBeLessThan(signals.indexOf("SIGKILL"));
  });

  it("reports NOT dead when the tree survives even SIGKILL", async () => {
    // Never dies within the poll budget (uninterruptible-sleep worker).
    const { io, signals } = fakeIO({ aliveFor: Number.POSITIVE_INFINITY });

    const dead = await killTreeAndWait(123, { io });

    expect(dead).toBe(false);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("falls back to group SIGKILL when the leader survives the first SIGKILL", async () => {
    let leaderAlive = true;
    let wedgedChildAlive = true;
    const signals: string[] = [];
    const io = {
      isAlive: () => leaderAlive,
      signal: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(`tree:${signal}`);
        // The wedged leader and child ignore the normal TERM/KILL escalation.
      },
      signalGroup: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(`group:${signal}`);
        leaderAlive = false;
        wedgedChildAlive = false;
      },
      sleep: async () => {},
    } satisfies KillTreeIO & {
      signalGroup(pid: number, signal: NodeJS.Signals): void;
    };

    const dead = await killTreeAndWait(123, {
      io,
      graceTries: 1,
      killTries: 1,
      pollMs: 0,
    });

    expect(dead).toBe(true);
    expect(wedgedChildAlive).toBe(false);
    expect(signals).toEqual(["tree:SIGTERM", "tree:SIGKILL", "group:SIGKILL"]);
  });

  it.runIf(process.platform !== "win32")(
    "fully reaps a SIGTERM-ignoring leader with a flat-cpu wedged child",
    async () => {
      const childProgram = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)';
      const leaderProgram = `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], {
          stdio: "ignore",
        });
        process.stdout.write(String(child.pid) + "\\n");
        setInterval(() => {}, 1_000);
      `;
      const leader = spawn(process.execPath, ["-e", leaderProgram], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!leader.pid || !leader.stdout) throw new Error("leader process did not expose pid/stdout");
      const leaderPid = leader.pid;
      let childPid = 0;

      try {
        childPid = await new Promise<number>((resolve, reject) => {
          leader.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim())));
          leader.once("error", reject);
          leader.once("exit", () => reject(new Error("leader exited before reporting its child")));
        });
        expect(childPid).toBeGreaterThan(1);

        const dead = await killTreeAndWait(leaderPid, {
          graceTries: 2,
          killTries: 20,
          pollMs: 10,
        });

        expect(dead).toBe(true);
        await waitUntilDead(leaderPid);
        await waitUntilDead(childPid);
      } finally {
        signalProcessGroup(leaderPid, "SIGKILL");
        if (childPid > 1) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    },
  );

  it("honours custom grace/kill try budgets", async () => {
    const sleep = vi.fn(async () => {});
    let alive = true;
    const io: KillTreeIO = {
      isAlive: () => alive,
      signal: (_pid, sig) => {
        // Ignore SIGTERM (forces the grace window to elapse), die on SIGKILL.
        if (sig === "SIGKILL") alive = false;
      },
      sleep,
    };

    const dead = await killTreeAndWait(123, { io, graceTries: 2, killTries: 2, pollMs: 5 });

    expect(dead).toBe(true);
    // 2 grace polls (still alive), then SIGKILL flips alive=false → confirmed.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
  });
});
