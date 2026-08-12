import { createGithubClient, type GithubBalance } from "@reddb-io/github";
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
  createWebhookWakeSource,
  waitForCommand,
  waitForGithubWorkflow,
  type WebhookForwarderPort,
} from "./index.js";

function githubBalance(remaining: number): GithubBalance {
  return {
    version: 1,
    origin: "asked",
    outcome: "asked",
    source: "GET /rate_limit",
    asked_at: "1970-01-01T00:00:00.000Z",
    request_count: 1,
    pools: {
      rest: {
        pool: "rest",
        resource: "core",
        limit: 5_000,
        remaining,
        used: 5_000 - remaining,
        reset_at: "1970-01-01T00:00:01.000Z",
        fraction: remaining / 5_000,
      },
      graphql: null,
      search: null,
    },
    unreported_pools: ["graphql", "search"],
    detail: "fixture",
  };
}

describe("castle workflow wait", () => {
  it("keeps a successful command result when notification fails", async () => {
    const notify = vi.fn(async () => {
      throw new Error("notification transport unavailable");
    });

    const result = await waitForCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready')"],
      timeoutMs: 5_000,
      notify,
    });

    expect(result).toMatchObject({
      status: "success",
      exitCode: 0,
      summary: "command exited successfully",
      stdout: "ready",
      stderr: "",
      notification: {
        status: "failure",
        error: "notification transport unavailable",
      },
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", exitCode: 0 }),
    );
  });

  it("terminates a command when its wait times out", async () => {
    const result = await waitForCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      timeoutMs: 25,
      terminateGraceMs: 25,
    });

    expect(result).toMatchObject({
      status: "timeout",
      exitCode: 2,
      summary: "command timed out after 25ms",
    });
  });

  it("cancels a command and reports an indeterminate workflow result", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 25);

    const result = await waitForCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      timeoutMs: 5_000,
      terminateGraceMs: 25,
      signal: abort.signal,
    });

    expect(result).toMatchObject({
      status: "indeterminate",
      exitCode: 2,
      summary: "command wait cancelled",
    });
  });

  it("honors the repository GitHub budget before polling again", async () => {
    let remaining = 0;
    let nowMs = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "completed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createGithubClient({
      token: "fixture-token",
      balance: () => githubBalance(remaining),
      fetchImpl,
      retryCount: 0,
      throttle: false,
    });
    const sleep = vi.fn(async (ms: number) => {
      nowMs += ms;
      remaining = 4_999;
    });

    const result = await waitForGithubWorkflow({
      client,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      now: () => nowMs,
      sleep,
      probe: async (github) => {
        await github.conditionalRest({
          cacheKey: "workflow:42",
          route: "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
          parameters: { owner: "acme", repo: "widgets", run_id: 42 },
          operation: { key: "run view", budget: "rest" },
        });
        return {
          status: "success",
          exitCode: 0,
          summary: "run 42 succeeded",
        };
      },
    });

    expect(result).toMatchObject({
      status: "success",
      exitCode: 0,
      summary: "run 42 succeeded",
    });
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("wakes GitHub polling from the resident webhook lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-workflow-webhook-"));
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths, { isPidAlive: () => true });
    await leases.acquire("github-webhook", {
      pid: 4_100,
      startTime: "resident-start",
    });
    const lane = createSingletonEventLane(paths);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      leases,
      lane,
      isLeaseHolderLive: async () => true,
      pollIntervalMs: 5,
    });
    const client = createGithubClient({
      token: "fixture-token",
      fetchImpl: async () => {
        throw new Error("probe fixture does not use transport");
      },
      retryCount: 0,
      throttle: false,
    });
    let probes = 0;
    const started = Date.now();

    const result = await waitForGithubWorkflow({
      client,
      timeoutMs: 5_000,
      pollIntervalMs: 10_000,
      webhook: { source, kind: "run", target: "42" },
      probe: async () => {
        probes += 1;
        if (probes === 1) {
          setTimeout(
            () =>
              void lane.append({
                singleton: "github-webhook",
                kind: "github.webhook.delivery",
                payload: { workflow_run: { id: 42 } },
              }),
            20,
          );
          return { status: "running", exitCode: 2, summary: "run pending" };
        }
        return { status: "success", exitCode: 0, summary: "run 42 succeeded" };
      },
    });

    expect(result.status).toBe("success");
    expect(probes).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_000);
    await rm(root, { recursive: true, force: true });
  });

  it("falls back to polling when webhook ownership is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-workflow-polling-"));
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
    });
    const client = createGithubClient({
      token: "fixture-token",
      fetchImpl: async () => {
        throw new Error("probe fixture does not use transport");
      },
      retryCount: 0,
      throttle: false,
    });
    const notify = vi.fn(async () => {
      throw new Error("notification failed");
    });
    let nowMs = 0;
    let probes = 0;

    const result = await waitForGithubWorkflow({
      client,
      timeoutMs: 1_000,
      pollIntervalMs: 50,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      webhook: { source, kind: "pr", target: "7" },
      notify,
      probe: async () => {
        probes += 1;
        return probes === 1
          ? { status: "running", exitCode: 2, summary: "checks pending" }
          : { status: "failure", exitCode: 1, summary: "checks failed" };
      },
    });

    expect(source.mode).toBe("polling");
    expect(probes).toBe(2);
    expect(result).toMatchObject({
      status: "failure",
      exitCode: 1,
      summary: "checks failed",
      notification: { status: "failure", error: "notification failed" },
    });
    await rm(root, { recursive: true, force: true });
  });

  it("delegates webhook wake to a per-wait forwarder without a resident", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-workflow-forwarder-"));
    const expectedWake = new AbortController().signal;
    const forwarder = new EventEmitter() as WebhookForwarderPort;
    forwarder.mode = "polling";
    forwarder.start = vi.fn();
    forwarder.stop = vi.fn(async () => undefined);
    forwarder.makeWakeSignalFor = vi.fn(() => () => expectedWake);
    const makeForwarder = vi.fn(() => forwarder);
    const source = createWebhookWakeSource({
      cwd: root,
      cancelSignal: new AbortController().signal,
      makeForwarder,
    });

    await source.start();

    expect(makeForwarder).toHaveBeenCalledTimes(1);
    expect(forwarder.start).toHaveBeenCalledTimes(1);
    expect(source.makeWakeSignalFor("run", "42")()).toBe(expectedWake);

    await source.stop();
    expect(forwarder.stop).toHaveBeenCalledTimes(1);
    await rm(root, { recursive: true, force: true });
  });

  it("reports only GitHub workflow state transitions and the final outcome", async () => {
    const client = createGithubClient({
      token: "fixture-token",
      fetchImpl: async () => {
        throw new Error("probe fixture does not use transport");
      },
      retryCount: 0,
      throttle: false,
    });
    const transitions: string[] = [];
    let nowMs = 0;
    let probes = 0;

    await waitForGithubWorkflow({
      client,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      onTransition: async (observation) => {
        transitions.push(`${observation.status}:${observation.summary}`);
      },
      probe: async () => {
        probes += 1;
        return probes < 3
          ? { status: "running", exitCode: 2, summary: "checks pending" }
          : { status: "success", exitCode: 0, summary: "checks passed" };
      },
    });

    expect(transitions).toEqual([
      "running:checks pending",
      "success:checks passed",
    ]);
  });
});
