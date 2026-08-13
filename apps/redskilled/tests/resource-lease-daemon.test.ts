import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRedskilledResourceLease,
  releaseRedskilledResourceLease,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const roots: string[] = [];
const running: RedskilledDaemon[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("daemon-owned generic resource admission (#3802)", () => {
  it("retains one lease across daemon handover and wakes the waiter on release", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-resource-daemon-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const firstDaemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      availableMemoryBytes: () => 8 * 1024 ** 3,
    });
    running.push(firstDaemon);
    const first = await acquireRedskilledResourceLease(paths, {
      resource: "validation-heavy",
      holder_id: "wFIRST",
      minimum_available_memory_bytes: 4 * 1024 ** 3,
      ttl_ms: 60_000,
      wait_timeout_ms: 5_000,
    });
    await firstDaemon.stop({ reason: "replaced" });
    running.splice(running.indexOf(firstDaemon), 1);

    const successor = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      availableMemoryBytes: () => 8 * 1024 ** 3,
    });
    running.push(successor);
    let admitted = false;
    const waiting = acquireRedskilledResourceLease(paths, {
      resource: "validation-heavy",
      holder_id: "wSECOND",
      minimum_available_memory_bytes: 4 * 1024 ** 3,
      ttl_ms: 60_000,
      wait_timeout_ms: 5_000,
    }).then((lease) => { admitted = true; return lease; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(admitted).toBe(false);

    await releaseRedskilledResourceLease(paths, first.lease_id);
    const second = await waiting;
    expect(second.holder_id).toBe("wSECOND");
    await releaseRedskilledResourceLease(paths, second.lease_id);
  });
});
