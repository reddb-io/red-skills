// What an AFK Worker logs reaches the host, or reaches no surface at all (#3079).
//
// The publisher existed, was exported, was documented in HOST-NOTES.md as a
// working feature — and had ZERO callers, so `daemon.ts`'s `source: "heartbeat"`
// branch never ran for a registration-lane Worker. The last test in this file is
// the ratchet for exactly that: an exported publisher nobody calls is what let
// this ship, and a grep is the only check that can see it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCastleWorkerLaneBridge,
  workerLogLine,
} from "../src/core/castle-worker-lane-bridge.js";
import {
  REDSKILLED_HOST_WORKER_ID_ENV,
  createWorkerLogLinePublisher,
  registrationLaunchEnv,
  registrationLogPathTemplate,
} from "../src/runtime/redskilled-worker-log.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-worker-log-"));
  roots.push(root);
  return root;
}

describe("what a registration declares", () => {
  it("names one file per Worker, in the disposable logs lane", () => {
    const path = registrationLogPathTemplate("/repo", "2026-08-02");

    expect(path).toBe("/repo/.red/tmp/logs/2026-08-02/worker-{{worker_id}}.log");
  });

  it("does not point the host at a lane the project itself writes", () => {
    // The daemon PIPES a Worker's stdout into the file it opens, so a declared
    // `worker.log.toonl` would interleave plain text into a TOONL lane — the log
    // this whole mechanism exists to expose.
    expect(registrationLogPathTemplate("/repo", "2026-08-02")).not.toContain("worker.log.toonl");
    expect(registrationLogPathTemplate("/repo", "2026-08-02")).not.toContain("/workers/");
  });

  it("hands each Worker the host's own handle for it, without renaming the work's", () => {
    expect(registrationLaunchEnv()).toEqual({ REDSKILLED_WORKER_ID: "{{worker_id}}" });
    expect(Object.keys(registrationLaunchEnv())).not.toContain("RED_AFK_WORKER_ID");
  });
});

describe("what a Worker publishes", () => {
  it("publishes nothing at all when the daemon did not birth it", async () => {
    const root = await scratch();

    expect(createWorkerLogLinePublisher({ root, env: {} })).toBeNull();
  });

  it("addresses the host with the id the host handed it", async () => {
    const root = await scratch();
    const sent: Array<{ worker_id: string; line: string }> = [];
    const publish = createWorkerLogLinePublisher({
      root,
      env: { [REDSKILLED_HOST_WORKER_ID_ENV]: "host-w-1" },
      publish: async (_paths, heartbeat) => {
        sent.push({ worker_id: heartbeat.worker_id, line: heartbeat.line });
        return { version: 1 } as never;
      },
    });

    await publish!("  worker.claimed #3079  ");

    expect(sent).toEqual([{ worker_id: "host-w-1", line: "worker.claimed #3079" }]);
  });

  it("costs the line and never the work when the daemon refuses or is gone", async () => {
    const root = await scratch();
    const publish = createWorkerLogLinePublisher({
      root,
      env: { [REDSKILLED_HOST_WORKER_ID_ENV]: "host-w-1" },
      publish: async () => {
        throw new Error("redskilled is not running");
      },
    });

    await expect(publish!("worker.landed #3079")).resolves.toBeUndefined();
  });
});

describe("the beat the bridge already keeps", () => {
  it("says the record it just wrote, once, to the host", async () => {
    const root = await scratch();
    const lines: string[] = [];
    const bridge = createCastleWorkerLaneBridge({
      redRoot: join(root, ".red"),
      workerId: "wTEST",
      attemptDir: () => "",
      publishHostLogLine: async (line) => {
        lines.push(line);
      },
    });

    await bridge.record("worker.claimed", { issue: 3079, runner: "claude" });

    expect(lines).toEqual(["worker.claimed issue=3079 runner=claude"]);
    // The lane is still written, byte for byte as it was: the host hears a copy,
    // it is not handed the log.
    const lane = await readFile(join(root, ".red", "tmp", "workers", "wTEST", "worker.log.toonl"), "utf8");
    expect(lane).toContain("worker.claimed");
  });

  it("behaves exactly as before for a Worker with no host to publish to", async () => {
    const root = await scratch();
    const bridge = createCastleWorkerLaneBridge({
      redRoot: join(root, ".red"),
      workerId: "wTEST",
      attemptDir: () => "",
    });

    await expect(bridge.record("worker.heartbeat")).resolves.toBeUndefined();
  });

  it("renders a line a statusline can print, dropping the structures it cannot", () => {
    expect(workerLogLine("worker.validated", 42, { gate: "green", detail: { rows: 3 } }))
      .toBe("worker.validated #42 gate=green");
  });
});
