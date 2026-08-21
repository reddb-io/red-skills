// The two halves of the contract, proved across a real ACP connection: the
// inner agent is REFUSED `git push` and `gh` with a reason it can read, and the
// Worker keeps the promise that refusal made by asking its parent to publish
// after the turn (issue #4016, ADR 0148, ADR 0144 §3).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server, Socket } from "node:net";
import {
  client,
  methods,
  type AgentConnection,
} from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_ACP_METHODS,
  REDSKILLS_WIRE_MAJOR,
  bindWorkerRendezvous,
  closeServer,
  removeAcpEndpoint,
  socketStream,
  type RedskilledPublishRequest,
} from "@reddb-io/protocol-acp";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowChildAgent } from "./child-agent.js";
import { runNativeAcpWorker } from "./native-worker.js";

const childFixture = resolve(__dirname, "fixtures", "terminal-policy-child.mjs");
const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await closeServer(server);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface StubTerminalOutcome {
  readonly command: string;
  readonly allowed: boolean;
  readonly exitCode?: number | null;
  readonly output?: string;
  readonly message?: string;
  readonly data?: unknown;
}

/** A Worktree with one commit, which is what the inner agent is allowed to leave. */
async function committedWorktree(prefix: string, branch: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--initial-branch", branch);
  git("config", "user.email", "worker@example.invalid");
  git("config", "user.name", "Worker");
  await writeFile(join(root, "edited.txt"), "only edits and commits\n");
  git("add", "--", "edited.txt");
  git("commit", "-m", "Refs #4016");
  return root;
}

describe("a child Agent asking the Worker for terminals", () => {
  it("is refused git push and gh with the typed reason, and allowed ordinary work", async () => {
    const cwd = await committedWorktree("worker-terminal-policy-", "afk/4016");
    const notices: unknown[] = [];
    const parent = {
      notify: async (_method: string, params: unknown) => void notices.push(params),
      request: async () => ({}),
    } as unknown as AgentConnection["client"];
    const child = new WorkflowChildAgent({
      endpoint: { agent: "redcode", transport: "stdio", command: process.execPath, args: [childFixture] },
      cwd,
      mcpServers: [],
      publicSessionId: "public-session",
      parent,
    });

    try {
      const response = await child.prompt({
        sessionId: "public-session",
        prompt: [{
          type: "text",
          text: [
            "run git :: push :: origin :: HEAD",
            "run gh :: pr :: create :: --fill",
            `run ${process.execPath} :: -e :: process.stdout.write('terminal-ok')`,
          ].join("\n"),
        }],
      });

      const terminals = (response._meta as {
        stub?: { terminals?: readonly StubTerminalOutcome[] };
      } | undefined)?.stub?.terminals ?? [];
      expect(terminals).toHaveLength(3);

      const [push, forge, ordinary] = terminals;
      expect(push?.allowed).toBe(false);
      expect(push?.message).toContain("publication-is-parent-owned");
      expect(forge?.allowed).toBe(false);
      expect(forge?.message).toContain("forge-cli-is-parent-owned");
      expect(ordinary?.allowed).toBe(true);
      expect(ordinary?.exitCode).toBe(0);
      expect(ordinary?.output).toBe("terminal-ok");
    } finally {
      await child.close();
    }

    // The refusal is not only the child's problem: the parent is told what the
    // policy taught, so a Worker log holds the lesson after the process is gone.
    const denials = notices.filter((notice) => (notice as {
      _meta?: { redskills?: { terminalPolicy?: unknown } };
    })._meta?.redskills?.terminalPolicy != null);
    expect(denials).toHaveLength(2);
  }, 30_000);
});

describe("a Worker finishing a prompt turn", () => {
  it("asks its parent to publish exactly once, naming the branch and the commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-publish-turn-"));
    roots.push(root);
    const socketPath = join(root, "worker.sock");
    const cwd = await committedWorktree("worker-publish-worktree-", "afk/4016-publish");
    const published: RedskilledPublishRequest[] = [];

    const rendezvous = await bindWorkerRendezvous(socketPath);
    servers.push(rendezvous.server);
    const worker = runNativeAcpWorker(socketPath, {
      agent: "redcode",
      transport: "stdio",
      command: process.execPath,
      args: [childFixture],
    });
    const socket = await rendezvous.connected;
    sockets.push(socket);
    // Not awaited: `close(cb)` only calls back once every accepted connection
    // has ended, and the one just accepted is the Worker's for the whole test.
    rendezvous.server.close();

    const parent = client({ name: "stub parent" })
      .onNotification(methods.client.session.update, () => undefined)
      .onRequest(
        REDSKILLS_ACP_METHODS.publish,
        (value: unknown) => value as RedskilledPublishRequest,
        ({ params }) => {
          published.push(params);
          return { receipt: "stub" };
        },
      );
    const connection = parent.connect(socketStream(socket));

    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "stub parent", version: "1" },
        _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
      });
      const session = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
      const response = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "complete workflow" }],
      });

      expect(response.stopReason).toBe("end_turn");
      expect(published).toHaveLength(1);
      expect(published[0]!.branch).toBe("afk/4016-publish");
      expect(published[0]!.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(published[0]!.idempotency_key).toContain(session.sessionId);

      // A second turn that committed nothing new is not a second publication.
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "complete workflow again" }],
      });
      expect(published).toHaveLength(1);
    } finally {
      connection.close();
      socket.destroy();
      await worker;
      await removeAcpEndpoint(socketPath);
    }
  }, 30_000);
});
