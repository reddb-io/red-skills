// The daemon leaves by boredom only when it holds nothing. ADR 0130 rule 7:
// it never idle-exits while it believes a Worker is alive — leaving then would
// abandon a budget no other authority is tracking.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-idle-"));
  roots.push(root);
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

const WORKER = {
  worker_id: "w-1",
  project_label: "alpha",
  pid: 4242,
  started_at: "2026-07-29T10:00:00.000Z",
  workspace_path: "/workspaces/alpha",
  isolated: true,
  unit: "red-worker-alpha-w-1.service",
  warnings: [] as string[],
};

describe("redskilled idle exit", () => {
  it("exits on idle while it holds no workers", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, idleMs: 20 });
    running.push(daemon);

    await daemon.closed;

    expect(await socketAnswers(paths.socketPath)).toBe(false);
    expect(daemon.workerCount()).toBe(0);
  });

  it("does not exit on idle while it believes a worker is alive", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, idleMs: 20 });
    running.push(daemon);
    daemon.trackWorker(WORKER);

    expect(daemon.evaluateIdle()).toBe("held-by-workers");
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(daemon.workerCount()).toBe(1);
  });

  it("releases the lease it held once it does exit", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, idleMs: 20 });
    running.push(daemon);
    daemon.trackWorker(WORKER);

    expect(daemon.releaseWorker(WORKER.worker_id)).toBe(true);
    expect(daemon.evaluateIdle()).toBe("exited");
    await daemon.closed;

    // The socket is gone and a fresh daemon can take the session straight away.
    expect(await socketAnswers(paths.socketPath)).toBe(false);
    const next = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(next);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
  });
});
