import { describe, expect, it } from "vitest";
import { mirrorPlan, type TrackedTask, type WorkerRecord } from "../src/core/mirror.js";
import {
  OPENCODE_HOST_NO_SERVER_NOTICE,
  OPENCODE_HOST_UNREACHABLE_NOTICE,
  openCodeHostSinkPlan,
  type OpenCodeHostClient,
} from "../src/core/opencode-host.js";

function running(
  worker_id: string,
  issue: number,
  title: string,
  activity: string,
  phase = "coding",
): WorkerRecord {
  return { worker_id, issue, title, slug: title, activity, phase, started_at: "x", status: "running" };
}

/** In-memory fake of the minimum OpenCode server interactions (no live process). */
function fakeClient(
  opts: {
    available?: boolean;
    tracked?: TrackedTask[];
    throwOn?: "available" | "readTasks" | "publishTasks";
  } = {},
): OpenCodeHostClient & { published: { sessionId: string; calls: unknown[] }[] } {
  const published: { sessionId: string; calls: unknown[] }[] = [];
  return {
    published,
    async available() {
      if (opts.throwOn === "available") throw new Error("connect ECONNREFUSED");
      return opts.available ?? true;
    },
    async readTasks() {
      if (opts.throwOn === "readTasks") throw new Error("read failed");
      return opts.tracked ?? [];
    },
    async publishTasks(sessionId, calls) {
      if (opts.throwOn === "publishTasks") throw new Error("publish failed");
      published.push({ sessionId, calls: [...calls] });
    },
  };
}

describe("opencode host sink (#888)", () => {
  const workers: WorkerRecord[] = [running("wAAAA", 22, "extract state.sh", "impl")];

  it("publishes the shared mirror plan when the host server is reachable", async () => {
    const client = fakeClient({ available: true, tracked: [] });
    const result = await openCodeHostSinkPlan(workers, client, "sess-1");
    expect(result.mirrored).toBe(true);
    expect(result.notice).toBeUndefined();
    // Same macro/micro vocabulary as the shared Task mirror — not a separate map.
    expect(result.plan).toEqual(mirrorPlan(workers, []));
    expect(client.published).toHaveLength(1);
    expect(client.published[0]!.sessionId).toBe("sess-1");
    expect(client.published[0]!.calls).toEqual(result.plan);
  });

  it("reconciles against the tracked tasks the server already holds", async () => {
    const tracked: TrackedTask[] = [{ key: "wAAAA:22", activity: "impl", phase: "coding" }];
    const client = fakeClient({ available: true, tracked });
    const result = await openCodeHostSinkPlan(workers, client, "sess-1");
    // Already in steady state on the server → no writes, nothing published.
    expect(result.mirrored).toBe(true);
    expect(result.plan).toEqual([]);
    expect(client.published).toEqual([]);
  });

  it("degrades to a no-op when no host client is configured (headless path preserved)", async () => {
    const result = await openCodeHostSinkPlan(workers, undefined, "sess-1");
    expect(result.mirrored).toBe(false);
    expect(result.plan).toEqual([]);
    expect(result.notice).toBe(OPENCODE_HOST_NO_SERVER_NOTICE);
  });

  it("degrades to a no-op when the configured server is unreachable", async () => {
    const client = fakeClient({ available: false });
    const result = await openCodeHostSinkPlan(workers, client, "sess-1");
    expect(result.mirrored).toBe(false);
    expect(result.plan).toEqual([]);
    expect(result.notice).toBe(OPENCODE_HOST_UNREACHABLE_NOTICE);
    expect(client.published).toEqual([]);
  });

  it("never throws: a server error during probe degrades cleanly", async () => {
    const client = fakeClient({ throwOn: "available" });
    const result = await openCodeHostSinkPlan(workers, client, "sess-1");
    expect(result.mirrored).toBe(false);
    expect(result.plan).toEqual([]);
    expect(result.notice).toBe(OPENCODE_HOST_UNREACHABLE_NOTICE);
  });

  it("never throws: a server error during publish degrades cleanly", async () => {
    const client = fakeClient({ available: true, throwOn: "publishTasks" });
    const result = await openCodeHostSinkPlan(workers, client, "sess-1");
    expect(result.mirrored).toBe(false);
    expect(result.notice).toBe(OPENCODE_HOST_UNREACHABLE_NOTICE);
  });

  it("operator notices separate host mirroring from the headless Agent runner", () => {
    // Both notices must name the headless runner so operators never confuse the
    // optional host surface with OpenCode-as-Agent-runner.
    expect(OPENCODE_HOST_NO_SERVER_NOTICE).toContain("headless");
    expect(OPENCODE_HOST_NO_SERVER_NOTICE).toContain("runner");
    expect(OPENCODE_HOST_UNREACHABLE_NOTICE).toContain("headless");
    expect(OPENCODE_HOST_UNREACHABLE_NOTICE).toContain("runner");
  });
});
