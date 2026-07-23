import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
  type SingletonEventLane,
} from "@reddb-io/red-castle/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResidentWebhook,
  type ResidentWebhookForwarder,
} from "../src/resident-webhook.js";

describe("resident webhook singleton", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("starts one forwarder when two residents share a live repo lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "resident-webhook-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths, {
      isPidAlive: () => true,
    });
    const lane = createSingletonEventLane(paths);
    const starts = vi.fn();
    const makeForwarder = (): ResidentWebhookForwarder => {
      const forwarder = new EventEmitter() as ResidentWebhookForwarder;
      forwarder.start = starts;
      forwarder.stop = vi.fn(async () => undefined);
      return forwarder;
    };
    const first = createResidentWebhook({
      root,
      owner: { pid: 4100, startTime: "first" },
      leases,
      lane,
      makeForwarder,
    });
    const second = createResidentWebhook({
      root,
      owner: { pid: 4200, startTime: "second" },
      leases,
      lane,
      makeForwarder,
    });

    expect(await first.start()).toMatchObject({ acquired: true });
    expect(await second.start()).toMatchObject({ acquired: false });
    expect(starts).toHaveBeenCalledTimes(1);

    await first.stop();
    await second.stop();
  });

  it("normalizes deliveries onto the event lane and logs malformed input", async () => {
    const root = await mkdtemp(join(tmpdir(), "resident-webhook-events-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths);
    const lane = createSingletonEventLane(paths, {
      clock: () => "2026-07-22T20:00:00.000Z",
    });
    const forwarder = new EventEmitter() as ResidentWebhookForwarder;
    forwarder.start = vi.fn();
    forwarder.stop = vi.fn(async () => undefined);
    const notice = vi.fn();
    const resident = createResidentWebhook({
      root,
      owner: { pid: process.pid, startTime: "resident-start" },
      leases,
      lane,
      makeForwarder: () => forwarder,
      notice,
    });
    await resident.start();

    forwarder.emit("delivery", { pull_request: { number: 2425 } });
    forwarder.emit("malformed-delivery", "not-json");
    await vi.waitFor(async () => {
      expect(await lane.read()).toEqual([
        {
          at: "2026-07-22T20:00:00.000Z",
          singleton: "github-webhook",
          kind: "github.webhook.delivery",
          payload: { pull_request: { number: 2425 } },
        },
      ]);
    });
    expect(notice).toHaveBeenCalledWith(
      "dropped malformed GitHub webhook delivery",
    );

    await resident.stop();
  });

  it("takes over a stale lease and releases it on clean shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "resident-webhook-takeover-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const staleOwner = { pid: 4100, startTime: "stale-start" };
    const leases = createSingletonLeaseStore(paths, {
      isPidAlive: (pid) => pid !== staleOwner.pid,
    });
    await leases.acquire("github-webhook", staleOwner);
    const forwarder = new EventEmitter() as ResidentWebhookForwarder;
    forwarder.start = vi.fn();
    forwarder.stop = vi.fn(async () => undefined);
    const resident = createResidentWebhook({
      root,
      owner: { pid: 4200, startTime: "replacement-start" },
      leases,
      lane: createSingletonEventLane(paths),
      makeForwarder: () => forwarder,
    });

    expect(await resident.start()).toMatchObject({
      acquired: true,
      reaped: true,
    });
    await resident.stop();

    expect(await leases.read("github-webhook")).toBeUndefined();
    expect(forwarder.stop).toHaveBeenCalledTimes(1);
  });

  it("drains an accepted delivery before releasing its lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "resident-webhook-drain-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths);
    let finishAppend!: () => void;
    const lane = {
      path: join(paths.castleStateRoot, "singleton-events.toonl"),
      read: vi.fn(async () => []),
      append: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            finishAppend = resolve as () => void;
          }),
      ),
    } as unknown as SingletonEventLane;
    const forwarder = new EventEmitter() as ResidentWebhookForwarder;
    forwarder.start = vi.fn();
    forwarder.stop = vi.fn(async () => undefined);
    const resident = createResidentWebhook({
      root,
      owner: { pid: process.pid, startTime: "resident-start" },
      leases,
      lane,
      makeForwarder: () => forwarder,
    });
    await resident.start();
    forwarder.emit("delivery", { workflow_run: { id: 987 } });
    expect(lane.append).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = resident.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    finishAppend();
    await stopping;
    expect(await leases.read("github-webhook")).toBeUndefined();
  });

  it("uses the owning repo identity when started below the repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "resident-webhook-root-"));
    roots.push(root);
    const nested = join(root, "packages", "child");
    await mkdir(join(root, ".red"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths);
    const forwarder = new EventEmitter() as ResidentWebhookForwarder;
    forwarder.start = vi.fn();
    forwarder.stop = vi.fn(async () => undefined);
    const resident = createResidentWebhook({
      root: nested,
      makeForwarder: () => forwarder,
    });

    await resident.start();

    expect(await leases.read("github-webhook")).toMatchObject({
      pid: process.pid,
    });

    await resident.stop();
  });
});
