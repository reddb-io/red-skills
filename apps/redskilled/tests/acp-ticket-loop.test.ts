/**
 * The whole Ticket loop, in a real process, with `redskilled acp-worker` as the
 * only Worker body (issue #4020, ADR 0148).
 *
 * Everything here is real except the tracker and the remote: a real `redskilled
 * acp-worker` process, a real child coding Agent process on the far side of a
 * real ACP connection, a real git Worktree, and a real gate command run in it.
 * What stands in is the daemon's two authorities — the Issue tracker write and
 * the GitHub gateway — because those are exactly the credentials ADR 0144 §3
 * says never reach this process. A stub that answers them is therefore not a
 * shortcut; it is the seam under test.
 *
 * **The dev bundle is proved absent, not assumed absent.** `red-skills-dev` is
 * planted on the Worker's PATH as a tripwire that records any invocation, and
 * the Worker's own argv is asserted to be the `acp-worker` re-exec. A flow that
 * reached for the retired body would leave one of the two behind.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server, Socket } from "node:net";
import { client, methods, type ClientConnection } from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_ACP_METHODS,
  REDSKILLS_WIRE_MAJOR,
  bindWorkerRendezvous,
  closeServer,
  socketStream,
  type RedskilledLandRequest,
  type RedskilledPublishRequest,
  type RedskillsTicketHandoff,
} from "@reddb-io/protocol-acp";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require_.resolve("tsx")).href;
const repoRoot = resolve(__dirname, "..", "..", "..");
const redskilledCli = join(repoRoot, "apps", "redskilled", "src", "cli.ts");
const ticketChild = join(repoRoot, "packages", "worker", "src", "acp", "fixtures", "ticket-child.mjs");

const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await closeServer(server);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** What the stub daemon was asked for, in the order the Worker asked. */
interface StubDaemon {
  readonly claims: { issue: number; body: string }[];
  readonly published: RedskilledPublishRequest[];
  readonly landed: RedskilledLandRequest[];
  readonly stages: { stage: string; ok: boolean; round?: number; detail?: string; added?: number; removed?: number }[];
  readonly denials: string[];
}

/** A fixture Project: one commit on trunk, one branch for the Worker to fill. */
async function fixtureRepository(branch: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ticket-loop-repo-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "worker@example.invalid");
  git("config", "user.name", "Worker");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@fixture/project", private: true }));
  git("add", "--all");
  git("commit", "-m", "Refs #4020: trunk");
  git("checkout", "-b", branch);
  return root;
}

/**
 * A `red-skills-dev` on PATH that records rather than runs.
 *
 * The tripwire's whole value is that its log file NOT EXISTING is the
 * assertion: a flow that reached the retired binary would have created it.
 */
async function tripwire(): Promise<{ dir: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "ticket-loop-tripwire-"));
  roots.push(root);
  const dir = join(root, "bin");
  await mkdir(dir, { recursive: true });
  const log = join(root, "dev-bundle-invocations.log");
  const shim = join(dir, "red-skills-dev");
  await writeFile(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  await chmod(shim, 0o755);
  return { dir, log };
}

interface RunningWorker {
  readonly process: ChildProcess;
  readonly argv: readonly string[];
  readonly connection: ClientConnection;
  readonly daemon: StubDaemon;
  readonly sessionId: string;
}

/** Start `redskilled acp-worker` and connect the stub daemon to its rendezvous. */
async function startWorker(worktree: string, pathPrefix: string): Promise<RunningWorker> {
  const socketRoot = await mkdtemp(join(tmpdir(), "ticket-loop-sock-"));
  roots.push(socketRoot);
  const socketPath = join(socketRoot, "worker.sock");
  const rendezvous = await bindWorkerRendezvous(socketPath);
  servers.push(rendezvous.server);

  const argv = [
    "--import", tsxLoader,
    redskilledCli,
    "acp-worker",
    "--socket", socketPath,
    "--child-agent", "redcode",
    "--child-command", process.execPath,
    "--child-arg", ticketChild,
  ];
  const worker = spawn(process.execPath, argv, {
    cwd: worktree,
    env: {
      ...process.env,
      HOME: socketRoot,
      XDG_RUNTIME_DIR: socketRoot,
      REDSKILLED_MACHINE_DIR: socketRoot,
      PATH: `${pathPrefix}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(worker);

  const socket = await rendezvous.connected;
  sockets.push(socket);
  // Not awaited: `close(cb)` calls back only once every accepted connection has
  // ended, and the one just accepted is the Worker's for the whole test.
  rendezvous.server.close();

  const daemon: StubDaemon = { claims: [], published: [], landed: [], stages: [], denials: [] };
  const parent = client({ name: "stub daemon" })
    .onNotification(methods.client.session.update, ({ params }) => {
      const meta = (params._meta as {
        redskills?: {
          ticketStage?: {
          stage: string; ok: boolean; round?: number; detail?: string;
          added?: number; removed?: number;
        };
          terminalPolicy?: { reason?: string };
        };
      } | undefined)?.redskills;
      if (meta?.ticketStage != null) daemon.stages.push(meta.ticketStage);
      if (meta?.terminalPolicy?.reason != null) daemon.denials.push(meta.terminalPolicy.reason);
    })
    .onRequest(
      REDSKILLS_ACP_METHODS.githubWrite,
      (value: unknown) => value as { write: { issue: number; body: string } },
      ({ params }) => {
        daemon.claims.push({ issue: params.write.issue, body: params.write.body });
        return { version: 1, published_at: "2026-08-19T12:00:00.000Z" };
      },
    )
    .onRequest(
      REDSKILLS_ACP_METHODS.publish,
      (value: unknown) => value as RedskilledPublishRequest,
      ({ params }) => {
        daemon.published.push(params);
        return {
          version: 1,
          worker_id: "stub",
          branch: params.branch,
          commit: params.commit,
          published_at: "2026-08-19T12:00:01.000Z",
        };
      },
    )
    .onRequest(
      REDSKILLS_ACP_METHODS.land,
      (value: unknown) => value as RedskilledLandRequest,
      ({ params }) => {
        daemon.landed.push(params);
        return {
          version: 1,
          worker_id: "stub",
          pull_request: 4321,
          branch: params.branch,
          base: params.base,
          custody_state: "active",
          handed_off_at: "2026-08-19T12:00:02.000Z",
        };
      },
    );
  const connection = parent.connect(socketStream(socket));

  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { terminal: true },
    clientInfo: { name: "stub daemon", version: "1" },
    _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
  });
  const session = await connection.agent.request(methods.agent.session.new, {
    cwd: worktree,
    mcpServers: [],
  });
  return { process: worker, argv, connection, daemon, sessionId: session.sessionId };
}

function ticket(overrides: Partial<RedskillsTicketHandoff> = {}): RedskillsTicketHandoff {
  return {
    number: 4020,
    title: "fix: #4020 The ACP Worker runs the whole Ticket loop end-to-end",
    labels: ["ready-for-agent"],
    base: "main",
    // The brief contract (#4139) refuses a handoff with no executable
    // acceptance criteria at the decoder, before the Ticket loop is entered.
    handoff: [
      "Implement Ticket #4020 in this Worktree and commit.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] Running `pnpm -C apps/redskilled test` passes.",
    ].join("\n"),
    worker_id: "stub-host:VSk6WPt",
    runner: "redcode",
    ...overrides,
  };
}

function headCommit(worktree: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, stdio: "pipe" }).toString().trim();
}

describe("a real `redskilled acp-worker` running one Ticket", () => {
  it("goes claim → implement → gate → publish request → land request", async () => {
    const worktree = await fixtureRepository("afk/4020-ticket-loop");
    const trap = await tripwire();
    const worker = await startWorker(worktree, trap.dir);

    try {
      const response = await worker.connection.agent.request(methods.agent.session.prompt, {
        sessionId: worker.sessionId,
        prompt: [{ type: "text", text: "run Ticket #4020" }],
        _meta: { redskills: { ticket: ticket({ backpressure_commands: ["test -f ticket.txt"] }) } },
      });

      const outcome = (response._meta as { redskills?: { ticket?: Record<string, unknown> } })
        ?.redskills?.ticket;
      expect(outcome?.outcome).toBe("landed");
      expect(outcome?.rounds).toBe(1);
      expect(outcome?.pullRequest).toBe(4321);

      // claim — a tracker write the Worker asked the daemon to perform.
      expect(worker.daemon.claims).toHaveLength(1);
      expect(worker.daemon.claims[0]!.issue).toBe(4020);
      expect(worker.daemon.claims[0]!.body).toContain("worker=stub-host:VSk6WPt");
      expect(worker.daemon.claims[0]!.body).toContain("runner=redcode");

      // implement — the child agent edited and committed in the real Worktree,
      // and was refused the one operation the parent owns.
      expect(await readFile(join(worktree, "ticket.txt"), "utf8")).toBe("implemented\n");
      expect(worker.daemon.denials).toContain("publication-is-parent-owned");

      // publish — the branch and commit the turn produced, named to the parent.
      expect(worker.daemon.published).toHaveLength(1);
      expect(worker.daemon.published[0]!.branch).toBe("afk/4020-ticket-loop");
      expect(worker.daemon.published[0]!.commit).toBe(headCommit(worktree));

      // land — custody armed against the Ticket that owns the merge.
      expect(worker.daemon.landed).toHaveLength(1);
      expect(worker.daemon.landed[0]!.base).toBe("main");
      expect(worker.daemon.landed[0]!.owner_ticket).toBe(4020);
      expect(worker.daemon.landed[0]!.body).toContain("Refs #4020");

      // the arc, as the Worker log saw it
      expect(worker.daemon.stages.map((stage) => stage.stage))
        .toEqual(["claim", "implement", "gate", "publish", "land"]);
      expect(worker.daemon.stages.every((stage) => stage.ok)).toBe(true);

      // and how much it had produced when each stage resolved. The claim is
      // taken before anything is written, so its honest answer is a measured
      // zero; every stage after the implementer's one-line file is `+1 -0`.
      // This is `loc=` at its source: the Worker measuring its own Worktree.
      expect(worker.daemon.stages.map((stage) => [stage.added, stage.removed])).toEqual([
        [0, 0], [1, 0], [1, 0], [1, 0], [1, 0],
      ]);

      // the dev bundle was never the body, and never reached for
      expect(worker.argv).toContain("acp-worker");
      expect(worker.argv.some((arg) => /red-skills-dev|dev\.bundle/.test(arg))).toBe(false);
      expect(existsSync(trap.log)).toBe(false);
    } finally {
      worker.connection.close();
    }
  }, 90_000);

  it("re-seeds in place when the gate blocks, and publishes only what turned green", async () => {
    const worktree = await fixtureRepository("afk/4020-reseed");
    const trap = await tripwire();
    const worker = await startWorker(worktree, trap.dir);

    try {
      const response = await worker.connection.agent.request(methods.agent.session.prompt, {
        sessionId: worker.sessionId,
        prompt: [{ type: "text", text: "run Ticket #4020" }],
        _meta: {
          redskills: {
            ticket: ticket({
              // Green only after the re-seeded round writes the marker, so the
              // first gate run BLOCKS against a real command in a real Worktree.
              backpressure_commands: ["test -f gate-marker.txt"],
              reseed_budget: 1,
            }),
          },
        },
      });

      const outcome = (response._meta as { redskills?: { ticket?: Record<string, unknown> } })
        ?.redskills?.ticket;
      expect(outcome?.outcome).toBe("landed");
      expect(outcome?.rounds).toBe(2);

      // The re-seed happened IN PLACE: same branch, and the first round's
      // commit is still an ancestor of what was published.
      expect(await readFile(join(worktree, "ticket.txt"), "utf8")).toBe("implemented\n");
      expect(await readFile(join(worktree, "gate-marker.txt"), "utf8")).toBe("green\n");
      expect(worker.daemon.published).toHaveLength(1);
      expect(worker.daemon.published[0]!.commit).toBe(headCommit(worktree));

      const gates = worker.daemon.stages.filter((stage) => stage.stage === "gate");
      expect(gates.map((stage) => stage.ok)).toEqual([false, true]);
      expect(gates[0]!.detail).toContain("backpressure");
      expect(worker.daemon.stages.filter((stage) => stage.stage === "implement")).toHaveLength(2);
      expect(existsSync(trap.log)).toBe(false);
    } finally {
      worker.connection.close();
    }
  }, 90_000);

  it("refuses a scout-lane Ticket before it claims, implements or publishes", async () => {
    const worktree = await fixtureRepository("afk/4020-scout");
    const trap = await tripwire();
    const worker = await startWorker(worktree, trap.dir);

    try {
      const response = await worker.connection.agent.request(methods.agent.session.prompt, {
        sessionId: worker.sessionId,
        prompt: [{ type: "text", text: "run Ticket #4020" }],
        _meta: { redskills: { ticket: ticket({ labels: ["ready-for-agent", "lane:scout"] }) } },
      });

      const outcome = (response._meta as {
        redskills?: { ticket?: { outcome?: string; stage?: string; detail?: string } };
      })?.redskills?.ticket;
      expect(outcome?.outcome).toBe("refused");
      expect(outcome?.stage).toBe("claim");
      expect(outcome?.detail).toContain("run_mode=scout");

      expect(worker.daemon.claims).toEqual([]);
      expect(worker.daemon.published).toEqual([]);
      expect(worker.daemon.landed).toEqual([]);
      expect(existsSync(join(worktree, "ticket.txt"))).toBe(false);
      expect(existsSync(trap.log)).toBe(false);
    } finally {
      worker.connection.close();
    }
  }, 90_000);
});
