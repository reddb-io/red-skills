// Nothing supplied the daemon's queue transport, so no Worker was ever born (#2974).
//
// The lane's middle third: a project registers, the daemon polls the tracker for
// every registered project, and the demand loop births what the depths allow. The
// poll was wired and disconnected — an absent transport returned before it asked,
// on every tick, and the silence it produced was indistinguishable from a host
// that had simply counted nothing yet. A registration, a stated target, two
// queued issues and zero Workers, with every surface reporting health.
//
// So this file proves the whole chain rather than its links: a real daemon over
// its real socket, a real registration from the real client, the real transport
// the CLI builds, a real HTTP request to a tracker standing in for GitHub, and a
// real child process on the machine at the end of it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { registerRedskilledProject } from "../src/client.js";
import {
  REDSKILLED_QUEUE_UNCONFIGURED_REASON,
  startRedskilledDaemon,
  type RedskilledDaemon,
} from "../src/daemon.js";
import { REDSKILLED_HOST_TOKEN_ENV, resolveServeQueueDiscovery } from "../src/cli.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-supply-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A tracker that answers every conditional REST search with one depth. */
async function trackerStandingIn(depth: number): Promise<{
  url: string;
  requests: string[];
  setDepth(depth: number): void;
}> {
  const requests: string[] = [];
  let currentDepth = depth;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://tracker.invalid");
    const query = url.searchParams.get("q") ?? "";
    requests.push(query);
    res.writeHead(200, {
      "content-type": "application/json",
      etag: `"${Buffer.from(query).toString("base64url")}"`,
      "x-ratelimit-remaining": "4900",
    });
    res.end(JSON.stringify(Array.from({ length: currentDepth }, (_, index) => ({ number: index + 1 }))));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`,
    requests,
    setDepth(nextDepth: number) {
      currentDepth = nextDepth;
    },
  };
}

function registration(label: string, workspace: string, target = 1) {
  const [owner, repo] = label.split("/") as [string, string];
  return {
    project_label: label,
    selector: `repo:${label} is:issue is:open label:"ready-for-agent"`,
    queue_poll: { owner, repo, labels: ["ready-for-agent"] },
    // A Worker that leaves proof it ran, in the workspace it was handed.
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('proof.txt', process.cwd());"],
    workspace_path: workspace,
    target,
  };
}

describe("whatever registers a project reaches the tracker for it", () => {
  it("confirms the direct label depth before birthing from an older positive sample", async () => {
    const tracker = await trackerStandingIn(4);
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const launched: unknown[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: (options) => {
        launched.push(options);
        throw new Error("a stale queue witness must not reach Worker birth");
      },
      queueDiscovery: {
        ...resolveServeQueueDiscovery({ "queue-endpoint": tracker.url }, { [REDSKILLED_HOST_TOKEN_ENV]: "t" }),
        intervalMs: 0,
      },
    });
    running.push(daemon);

    await registerRedskilledProject(paths, registration("acme/widgets", workspace, 4), { readyTimeoutMs: 5_000 });
    await daemon.pollQueueDiscovery();
    tracker.setDepth(0);

    const tick = await daemon.driveDemand();

    expect(tracker.requests).toHaveLength(2);
    expect(tick.requested).toBe(0);
    expect(tick.granted).toEqual([]);
    expect(launched).toEqual([]);
  });

  it("births a Worker for a registered project with a matching queue, end to end", async () => {
    const tracker = await trackerStandingIn(3);
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    // The transport the SHIPPED path builds, from a token and an endpoint — not
    // a stub function a test wrote. Only the tracker is standing in.
    const queueDiscovery = resolveServeQueueDiscovery(
      { "queue-endpoint": tracker.url },
      { [REDSKILLED_HOST_TOKEN_ENV]: "test-token" },
    );
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      queueDiscovery: { ...queueDiscovery, intervalMs: 0 },
    });
    running.push(daemon);

    // Registered the way a project registers: over the socket, from the client.
    await registerRedskilledProject(paths, registration("acme/widgets", workspace), { readyTimeoutMs: 5_000 });
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    // The periodic sample is followed by the demand tick's direct pre-birth confirmation.
    expect(tracker.requests).toHaveLength(2);
    expect(tick.granted).toHaveLength(1);
    expect(daemon.workerCount()).toBe(1);
    // The Worker really ran: the machine has a process's output on it.
    await expect
      .poll(async () => await readFile(join(workspace, "proof.txt"), "utf8").catch(() => ""), { timeout: 10_000 })
      .toBe(workspace);
  });

  it("makes one conditional request per registered project", async () => {
    // N round trips are the deliberate cost of making each unchanged collection
    // free against the API budget instead of charging one aliased GraphQL query.
    const tracker = await trackerStandingIn(2);
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: {
        ...resolveServeQueueDiscovery({ "queue-endpoint": tracker.url }, { [REDSKILLED_HOST_TOKEN_ENV]: "t" }),
        intervalMs: 0,
      },
    });
    running.push(daemon);

    for (const label of ["acme/a", "acme/b", "acme/c"]) {
      await registerRedskilledProject(paths, registration(label, workspace, 0), { readyTimeoutMs: 5_000 });
    }
    const discovery = await daemon.pollQueueDiscovery();

    expect(tracker.requests).toHaveLength(3);
    expect(discovery!.request_count).toBe(3);
    expect(discovery!.projects.map((entry) => entry.project_label)).toEqual(["acme/a", "acme/b", "acme/c"]);
  });

  it("keeps a failed poll distinguishable from an empty queue", async () => {
    // A tracker that refuses is not a drained backlog. Nothing is born, and the
    // depth stays absent rather than becoming the zero that reads as "done".
    const server = createServer((_req, res) => {
      res.writeHead(403, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
      });
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      queueDiscovery: {
        ...resolveServeQueueDiscovery({ "queue-endpoint": url }, { [REDSKILLED_HOST_TOKEN_ENV]: "t" }),
        intervalMs: 0,
      },
    });
    running.push(daemon);

    await registerRedskilledProject(paths, registration("acme/widgets", workspace), { readyTimeoutMs: 5_000 });
    const discovery = await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    expect(discovery!.projects[0]!.outcome).toBe("rate-limited");
    expect(discovery!.projects[0]!.depth).toBeNull();
    expect(tick.projects[0]!.outcome).toBe("queue-unknown");
    expect(daemon.workerCount()).toBe(0);
  });
});

describe("a daemon that polls no tracker says so", () => {
  it("reports an unconfigured poll on every registration, never a silent absence", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
    });
    running.push(daemon);

    await registerRedskilledProject(paths, registration("acme/widgets", workspace), { readyTimeoutMs: 5_000 });
    const discovery = await daemon.pollQueueDiscovery();

    expect(discovery!.projects[0]!.outcome).toBe("unconfigured");
    expect(discovery!.projects[0]!.depth).toBeNull();
    expect(discovery!.projects[0]!.detail).toContain(REDSKILLED_QUEUE_UNCONFIGURED_REASON);
    // No request was made, and the cost says so rather than claiming one.
    expect(discovery!.request_count).toBe(0);
    // The one read an operator makes — "a registration and no Workers, why?"
    const polled = daemon.hostState().registrations?.[0]?.last_poll;
    expect(polled?.outcome).toBe("unconfigured");
    expect(polled?.depth).toBeNull();
  });

  it("carries the reason of whoever would have armed it, naming what was missing", async () => {
    const unarmed = resolveServeQueueDiscovery({}, {}, () => null);

    expect(unarmed.transport).toBeUndefined();
    expect(unarmed.unconfiguredReason).toContain(REDSKILLED_HOST_TOKEN_ENV);
    expect(unarmed.unconfiguredReason).toContain("gh auth token");
  });

  it("births nothing on an unconfigured poll, and holds the project rather than retiring it", async () => {
    // The distinction the whole amendment turns on: an uncounted queue is not a
    // drained one, so the project waits instead of being read as finished.
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
    });
    running.push(daemon);

    await registerRedskilledProject(paths, registration("acme/widgets", workspace), { readyTimeoutMs: 5_000 });
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    expect(tick.projects[0]!.outcome).toBe("queue-unknown");
    expect(tick.granted).toHaveLength(0);
    expect(daemon.workerCount()).toBe(0);
    expect(daemon.hostState().registrations).toHaveLength(1);
  });
});

describe("the credential this host polls with", () => {
  it("reads the tracker CLI's stored login when the environment names none", async () => {
    // The auto-spawned daemon inherits whatever session first needed it, and a
    // developer authenticated with `gh auth login` has no token in it at all —
    // which left the poller unarmed on machines with a working credential.
    const armed = resolveServeQueueDiscovery({}, {}, () => "stored-token");

    expect(armed.transport).toBeTypeOf("function");
    expect(armed.unconfiguredReason).toBeUndefined();
  });

  it("prefers the environment, so one host polls with one credential", async () => {
    let asked = 0;
    const armed = resolveServeQueueDiscovery({}, { [REDSKILLED_HOST_TOKEN_ENV]: "env-token" }, () => {
      asked += 1;
      return "stored-token";
    });

    expect(armed.transport).toBeTypeOf("function");
    expect(asked).toBe(0);
  });
});
