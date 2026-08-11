// A real project registration must arm both tracker polls (#3605).
//
// The selector poll already receives the daemon's host-scoped transport. The
// activity poll used to require a separate boot-only project list, so the
// ordinary project_start/MCP registration could never produce remote counters.
// This test poses the shipped boundary: real daemon, real socket registration,
// production budget-aware transport, and one tracker standing in for GitHub.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { registerRedskilledProject } from "../src/client.js";
import { REDSKILLED_HOST_TOKEN_ENV, resolveServeQueueDiscovery } from "../src/cli.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-counter-supply-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

async function trackerStandingIn(): Promise<{
  readonly url: string;
  readonly requests: Array<{ readonly path: string; readonly authorization: string | undefined }>;
}> {
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://tracker.invalid");
    requests.push({ path: `${url.pathname}?${url.searchParams.toString()}`, authorization: req.headers.authorization });

    let body: readonly Record<string, unknown>[];
    if (url.pathname.endsWith("/pulls")) {
      body = [{ number: 1 }, { number: 2 }];
    } else if (url.pathname.endsWith("/search/issues")) {
      res.writeHead(200, {
        "content-type": "application/json",
        etag: `"${requests.length}"`,
        "x-ratelimit-remaining": "4900",
      });
      res.end(JSON.stringify({ total_count: 4, items: [] }));
      return;
    } else if (url.searchParams.get("state") === "closed") {
      body = [{ number: 20, closed_at: "2026-08-11T12:00:00.000Z" }];
    } else if (url.searchParams.has("labels")) {
      body = [{ number: 10, labels: [{ name: "ready-for-agent" }] }];
    } else {
      body = [
        { number: 10, labels: [{ name: "ready-for-agent" }] },
        { number: 11, labels: [{ name: "ready-for-human" }] },
        { number: 12, labels: [] },
      ];
    }
    res.writeHead(200, {
      "content-type": "application/json",
      etag: `"${requests.length}"`,
      "x-ratelimit-remaining": "4900",
    });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`, requests };
}

describe("the registration supplies the remote-counter poll", () => {
  it("fills the dated counters in one poll cycle through the selector's transport", async () => {
    const tracker = await trackerStandingIn();
    const paths = await sessionPaths();
    const queueDiscovery = resolveServeQueueDiscovery(
      { "queue-endpoint": tracker.url },
      { [REDSKILLED_HOST_TOKEN_ENV]: "shared-host-token" },
    );
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      idleMs: 60_000,
      demandMs: 0,
      queueDiscovery: { ...queueDiscovery, intervalMs: 0 },
    });
    running.push(daemon);

    // No registration means no repository and no invented zero or fetch.
    const absent = daemon.statuslinePayload();
    expect(absent.repository_activity.fetched_at).toBeNull();
    expect(absent.remote_counters?.projects).toEqual([]);
    expect(tracker.requests).toHaveLength(0);

    // Both label names are project-authored. The daemon compares strings but
    // never learns what either label means.
    const queuePoll = {
      owner: "acme",
      repo: "widgets",
      labels: ["ready-for-agent"],
      counter_labels: { ready: "ready-for-agent", human: "ready-for-human" },
    };
    await registerRedskilledProject(paths, {
      project_label: "acme/widgets",
      selector: "repo:acme/widgets is:issue is:open label:ready-for-agent",
      queue_poll: queuePoll,
      argv: [process.execPath, "worker.mjs"],
      workspace_path: "/workspace/acme/widgets",
      target: 0,
    }, { readyTimeoutMs: 5_000 });

    await daemon.pollQueueDiscovery();
    await daemon.pollRepositoryActivity();

    const payload = daemon.statuslinePayload();
    const counters = payload.remote_counters!.projects[0]!.counters;
    expect(counters.open_pull_requests).toMatchObject({ value: 2, fetched_at: expect.any(String) });
    expect(counters.open_issues).toMatchObject({ value: 3, fetched_at: expect.any(String) });
    expect(counters.merged_today).toMatchObject({ value: 4, fetched_at: expect.any(String), age_ms: expect.any(Number) });
    expect(counters.ready_queue).toMatchObject({ value: 1, fetched_at: expect.any(String) });
    expect(counters.human_queue).toMatchObject({ value: 1, fetched_at: expect.any(String) });
    expect(payload.repository_activity.projects[0]).toMatchObject({
      counts: { recently_closed: 1 },
      fetched_at: expect.any(String),
    });

    // One selector list plus the activity cycle's four reads. Payload reads
    // remain cache-only, and every request used the one registration transport.
    daemon.statuslinePayload();
    daemon.statuslinePayload();
    expect(tracker.requests).toHaveLength(5);

    // The next attended cycle refreshes only the open-Issue representation that
    // feeds the ready queue. Panorama counts remain last-known and retain their
    // own earlier instant until their longer tier expires.
    const panoramaAt = counters.merged_today.fetched_at;
    await daemon.pollRepositoryActivity();
    const refreshed = daemon.statuslinePayload().remote_counters!.projects[0]!.counters;
    expect(tracker.requests).toHaveLength(6);
    expect(refreshed.ready_queue.fetched_at).not.toBeNull();
    expect(refreshed.merged_today.fetched_at).toBe(panoramaAt);
    expect(tracker.requests.every((request) => request.authorization === "token shared-host-token")).toBe(true);
  });
});
