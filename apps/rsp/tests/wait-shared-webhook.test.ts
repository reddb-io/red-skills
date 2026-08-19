import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
  singletonLeasePath,
  type SingletonEventLane,
} from "@reddb-io/worker/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookWakeSource,
  type WebhookForwarderPort,
} from "../src/wait/webhook-wake-source.js";

describe("shared webhook wake source", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("subscribes to a live resident lane without spawning a fallback forwarder", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-webhook-wait-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths, {
      isPidAlive: () => true,
    });
    await leases.acquire("github-webhook", {
      pid: 4100,
      startTime: "resident-start",
    });
    const lane = createSingletonEventLane(paths);
    const fallback = new EventEmitter() as WebhookForwarderPort;
    fallback.mode = "polling";
    fallback.start = vi.fn();
    fallback.stop = vi.fn(async () => undefined);
    fallback.makeWakeSignalFor = vi.fn(() => () => undefined);
    const makeForwarder = vi.fn(() => fallback);
    const abort = new AbortController();
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: abort.signal,
      leases,
      lane,
      isLeaseHolderLive: async () => true,
      pollIntervalMs: 5,
      makeForwarder,
    });

    await source.start();
    const wake = source.makeWakeSignalFor("pr", "2425")();
    await lane.append({
      singleton: "github-webhook",
      kind: "github.webhook.delivery",
      payload: { pull_request: { number: 2425 } },
    });

    await vi.waitFor(() => expect(wake?.aborted).toBe(true));
    expect(source.mode).toBe("webhook");
    expect(makeForwarder).not.toHaveBeenCalled();

    await source.stop();
  });

  it("delegates to the existing per-wait forwarder when no holder exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "fallback-webhook-wait-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths);
    const lane = createSingletonEventLane(paths);
    const expectedWake = new AbortController().signal;
    const fallback = new EventEmitter() as WebhookForwarderPort;
    fallback.mode = "polling";
    fallback.start = vi.fn();
    fallback.stop = vi.fn(async () => undefined);
    fallback.makeWakeSignalFor = vi.fn(() => () => expectedWake);
    const makeForwarder = vi.fn(() => fallback);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      leases,
      lane,
      isLeaseHolderLive: async () => true,
      makeForwarder,
    });

    await source.start();

    expect(makeForwarder).toHaveBeenCalledTimes(1);
    expect(fallback.start).toHaveBeenCalledTimes(1);
    expect(source.makeWakeSignalFor("run", "987")()).toBe(expectedWake);

    await source.stop();
    expect(fallback.stop).toHaveBeenCalledTimes(1);
  });

  it("does not read stale shared-lane bytes when no holder exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "stale-shared-webhook-wait-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths);
    const lane = createSingletonEventLane(paths);
    await mkdir(join(root, ".red", "state", "castle"), { recursive: true });
    await writeFile(lane.path, "not a singleton event lane", "utf8");
    const fallback = new EventEmitter() as WebhookForwarderPort;
    fallback.mode = "polling";
    fallback.start = vi.fn();
    fallback.stop = vi.fn(async () => undefined);
    fallback.makeWakeSignalFor = vi.fn(() => () => undefined);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      leases,
      lane,
      isLeaseHolderLive: async () => true,
      makeForwarder: () => fallback,
    });

    await expect(source.start()).resolves.toBeUndefined();
    expect(fallback.start).toHaveBeenCalledTimes(1);

    await source.stop();
  });

  it("delegates to the fallback when the resident lease is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "broken-webhook-lease-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leasePath = singletonLeasePath(paths, "github-webhook");
    await mkdir(join(root, ".red", "state", "castle", "singletons", "github-webhook"), {
      recursive: true,
    });
    await writeFile(leasePath, "not a singleton lease", "utf8");
    const fallback = new EventEmitter() as WebhookForwarderPort;
    fallback.mode = "polling";
    fallback.start = vi.fn();
    fallback.stop = vi.fn(async () => undefined);
    fallback.makeWakeSignalFor = vi.fn(() => () => undefined);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      makeForwarder: () => fallback,
    });

    await expect(source.start()).resolves.toBeUndefined();
    expect(fallback.start).toHaveBeenCalledTimes(1);

    await source.stop();
  });

  it("degrades to the per-wait forwarder when the resident releases its lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "released-webhook-wait-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths, {
      isPidAlive: () => true,
    });
    const owner = { pid: 4100, startTime: "resident-start" };
    await leases.acquire("github-webhook", owner);
    const lane = createSingletonEventLane(paths);
    const fallback = new EventEmitter() as WebhookForwarderPort;
    fallback.mode = "polling";
    fallback.start = vi.fn();
    fallback.stop = vi.fn(async () => undefined);
    fallback.makeWakeSignalFor = vi.fn(() => () => undefined);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      leases,
      lane,
      isLeaseHolderLive: async () => true,
      pollIntervalMs: 5,
      makeForwarder: () => fallback,
    });
    await source.start();
    const wake = source.makeWakeSignalFor("pr", "2425")();

    await leases.release("github-webhook", owner);

    await vi.waitFor(() => expect(fallback.start).toHaveBeenCalledTimes(1));
    expect(source.mode).toBe("polling");
    fallback.emit("delivery", { pull_request: { number: 2425 } });
    expect(wake?.aborted).toBe(true);

    await source.stop();
  });

  it("degrades to the per-wait forwarder when the shared lane becomes unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "broken-shared-webhook-wait-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths, {
      isPidAlive: () => true,
    });
    await leases.acquire("github-webhook", {
      pid: 4100,
      startTime: "resident-start",
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("lane unavailable"));
    const lane = {
      path: join(paths.castleStateRoot, "singleton-events.toonl"),
      read,
      append: vi.fn(),
    } as unknown as SingletonEventLane;
    const fallback = new EventEmitter() as WebhookForwarderPort;
    fallback.mode = "polling";
    fallback.start = vi.fn();
    fallback.stop = vi.fn(async () => undefined);
    fallback.makeWakeSignalFor = vi.fn(() => () => undefined);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      leases,
      lane,
      isLeaseHolderLive: async () => true,
      pollIntervalMs: 5,
      makeForwarder: () => fallback,
    });
    await source.start();

    await vi.waitFor(() => expect(fallback.start).toHaveBeenCalledTimes(1));

    await source.stop();
  });
});
