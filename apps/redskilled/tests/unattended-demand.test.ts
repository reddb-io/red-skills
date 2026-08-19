// A registration drains with nobody watching it, or it drains nothing (#3056).
//
// The lane's last third. #2974 proved the chain link by link — a real socket, a
// real registration, the real transport, a real child — but it drove the two
// halves by hand: `pollQueueDiscovery()` and `driveDemand()` were CALLED by the
// test. On a real machine nobody calls them; a timer does, inside a daemon that
// was auto-spawned by whatever session first touched the socket and that outlives
// every one of them.
//
// So this file registers and then LETS GO. Three properties, all of them the
// unattended kind:
//
//  1. A registered project with a matching queue births a Worker on the daemon's
//     own clock, with no session alive and no method called.
//  2. A daemon that could not resolve a credential AT START arms itself once one
//     exists, instead of polling nothing for the life of the process — the field
//     shape of #3056: a valid registration, free slots, and 20 quiet minutes.
//  3. What sustains the registration and what lets the daemon idle out both
//     follow from the poll OUTCOME, and the outcome is readable from the one
//     surface an operator reads.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { registerRedskilledProject } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { REDSKILLED_HOST_TOKEN_ENV, resolveServeQueueDiscovery } from "../src/cli.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { createGitHubActivityTransport } from "../src/repository-activity.js";

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
  const root = await scratch("redskilled-unattended-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A tracker that answers every conditional REST search with one depth. */
async function trackerStandingIn(depth: number): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://tracker.invalid");
    const query = url.searchParams.get("q") ?? "";
    requests.push(query);
    res.writeHead(200, {
      "content-type": "application/json",
      etag: `"${Buffer.from(query).toString("base64url")}"`,
      "x-ratelimit-remaining": "4900",
    });
    res.end(JSON.stringify(Array.from({ length: depth }, (_, index) => ({ number: index + 1 }))));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`, requests };
}

function registration(label: string, workspace: string, target = 1, renewWithinMs?: number) {
  const [owner, repo] = label.split("/") as [string, string];
  return {
    project_label: label,
    selector: `repo:${label} is:issue is:open label:"ready-for-agent"`,
    queue_poll: { owner, repo, labels: ["ready-for-agent"] },
    // A Worker that leaves proof it ran, in the workspace it was handed.
    argv: [process.execPath, "-e", "require('node:fs').writeFileSync('proof.txt', process.cwd());"],
    workspace_path: workspace,
    target,
    ...(renewWithinMs == null ? {} : { renew_within_ms: renewWithinMs }),
  };
}

describe("a registration drains with no session alive behind it", () => {
  it("births a Worker on the daemon's own clock, with nothing calling the loop", async () => {
    const tracker = await trackerStandingIn(3);
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      // Real windows, only shortened: the loop is armed exactly as `serve` arms it.
      demandMs: 50,
      queueDiscovery: {
        ...resolveServeQueueDiscovery({ "queue-endpoint": tracker.url }, { [REDSKILLED_HOST_TOKEN_ENV]: "t" }),
        intervalMs: 50,
      },
    });
    running.push(daemon);

    // Registered the way a project registers, over the socket — and then nothing.
    // No poll is asked for, no tick is driven, no session stays alive.
    await registerRedskilledProject(paths, registration("acme/widgets", workspace), { readyTimeoutMs: 5_000 });

    // Same deadline reasoning as its sibling below: this waits on a real Worker
    // reaching disk, so it is sized for a loaded machine rather than a quiet one.
    await expect
      .poll(async () => await readFile(join(workspace, "proof.txt"), "utf8").catch(() => ""), { timeout: 30_000 })
      .toBe(workspace);
    // Asked for by the loop, not by this test: the daemon's own tick holds the
    // depth it planned against, from a poll nobody in this process requested.
    expect(daemon.demand()?.projects[0]?.queue_depth).toBe(3);
  }, 60_000);
});

describe("a daemon that could not arm at start arms itself when it can", () => {
  it("polls with a credential that appeared after the session which spawned it left", async () => {
    // The field shape of #3056. The daemon is auto-spawned by whatever session
    // first touches the socket (ADR 0130 rule 7), and it inherits that session's
    // environment — which may hold no token and reach no tracker CLI. Resolved
    // once at start, that daemon polls NOTHING for its whole life, so every later
    // registration made by a session that DID hold a credential lapses uncounted
    // one window later while every surface reports the host healthy.
    const tracker = await trackerStandingIn(2);
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    let credential: string | null = null;
    const queueDiscovery = resolveServeQueueDiscovery(
      { "queue-endpoint": tracker.url },
      {},
      // The tracker CLI as the daemon meets it: silent at start, answering later.
      () => credential,
    );
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 50,
      queueDiscovery: { ...queueDiscovery, intervalMs: 50 },
    });
    running.push(daemon);

    // Nothing was armed at start, and the host says so rather than falling silent.
    expect(queueDiscovery.transport).toBeUndefined();
    await registerRedskilledProject(paths, registration("acme/widgets", workspace), { readyTimeoutMs: 5_000 });
    await expect
      .poll(() => daemon.hostState().registrations?.[0]?.last_poll?.outcome, { timeout: 15_000 })
      .toBe("unconfigured");
    expect(daemon.workerCount()).toBe(0);

    credential = "a-token-that-exists-now";

    // This waits on a real Worker being born and reaching disk, not on a state
    // transition in memory — so the deadline has to fit the slowest machine that
    // runs it, not the quietest. At 10s it passed alone and failed about one full
    // suite run in four, which is the worst way for a gate to behave: red for
    // reasons that have nothing to do with the change under review. Waiting
    // longer costs nothing when it passes — the poll returns the moment the file
    // is there.
    await expect
      .poll(async () => await readFile(join(workspace, "proof.txt"), "utf8").catch(() => ""), { timeout: 30_000 })
      .toBe(workspace);
    expect(daemon.hostState().registrations?.[0]?.last_poll?.outcome).toBe("counted");
  }, 60_000);
});

describe("the sustain and the idle exit follow the poll outcome", () => {
  it("holds a registration past its own window on a counted, open queue", async () => {
    const tracker = await trackerStandingIn(5);
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      // No births: this is about what keeps the RECORD standing, not about work.
      demandMs: 0,
      queueDiscovery: {
        transport: createGitHubActivityTransport({
          token: "t",
          endpoint: tracker.url,
          retryCount: 0,
          throttle: false,
        }),
        intervalMs: 40,
      },
    });
    running.push(daemon);

    await registerRedskilledProject(paths, registration("acme/widgets", workspace, 0, 250), { readyTimeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    const held = daemon.hostState().registrations ?? [];
    expect(held).toHaveLength(1);
    // Sustained by the daemon's own poll, with nobody renewing it — and reported
    // as such, because "nobody is watching this" stays true.
    expect(held[0]!.sustained_by).toBe("open-work");
  });

  it("lets a registration nothing counted lapse, so nothing is held behind it", async () => {
    // The other side of the same rule: an uncounted queue sustains nothing, so a
    // host that cannot ask stops holding a promise it cannot keep — with the poll
    // outcome saying WHY on the way out, never a bare disappearance.
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      // No transport and no way to get one: the poll can only report why.
      queueDiscovery: { intervalMs: 40 },
    });
    running.push(daemon);

    await registerRedskilledProject(paths, registration("acme/widgets", workspace, 0, 250), { readyTimeoutMs: 5_000 });
    await expect
      .poll(() => daemon.hostState().registrations?.[0]?.last_poll?.outcome, { timeout: 5_000 })
      .toBe("unconfigured");

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(daemon.hostState().registrations ?? []).toHaveLength(0);
  });
});
