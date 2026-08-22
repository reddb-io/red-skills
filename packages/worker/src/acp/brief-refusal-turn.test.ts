// A brief the contract refuses ends the turn saying so (issue #4296).
//
// The defect this pins was invisible in exactly the way a decoder's `undefined`
// is invisible: the Worker read "no Ticket handoff", took the ordinary prompt
// path, echoed and ended `end_turn`. The daemon read a healthy turn, the item
// kept `ready-for-agent`, and the planner birthed again every ~15s — ~60
// Workers on one item, twice, on an operator's machine.
//
// So the assertions are about the two answers being DIFFERENT: a refused brief
// carries the contract's sentence out of the turn, and an absent handoff still
// walks the legal prompt path it always walked.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, Socket } from "node:net";

import { client, methods } from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_ACP_METHODS,
  REDSKILLS_WIRE_MAJOR,
  bindWorkerRendezvous,
  closeServer,
  removeAcpEndpoint,
  socketStream,
} from "@reddb-io/protocol-acp";
import { afterEach, describe, expect, it } from "vitest";

import {
  TICKET_BRIEF_REFUSAL_STAGE,
  briefRefusalResponse,
  ticketDecisionForTurn,
} from "./brief-refusal-turn.js";
import { runNativeAcpWorker } from "./native-worker.js";

/** The shape the operator's own Ticket had: prose acceptance criteria. */
const PROSE_BRIEF = `Decide the token scale.

Record the decision with its reasoning. No acceptance criteria stated.
`;

const EXECUTABLE_BRIEF = `Implement the slice.

## Acceptance criteria

- [ ] Running \`pnpm -C packages/worker test\` passes.
`;

const ticketMeta = (handoff: string): unknown => ({
  redskills: {
    ticket: {
      number: 518,
      title: "Decide the token scale",
      labels: ["ready-for-agent"],
      base: "main",
      handoff,
      worker_id: "host:VSk6WPt",
    },
  },
});

describe("the turn's Ticket decision", () => {
  it("keeps a refusal a refusal instead of collapsing it into an absence", () => {
    const decision = ticketDecisionForTurn(ticketMeta(PROSE_BRIEF), undefined);
    expect(decision.kind).toBe("refused");
    expect(decision.kind === "refused" && decision.reason)
      .toContain("brief contract refused");
  });

  it("falls back to the session's Ticket only when the turn states none", () => {
    expect(ticketDecisionForTurn(undefined, ticketMeta(EXECUTABLE_BRIEF)).kind).toBe("handoff");
    // A session refusal is not laundered by a prompt that claims no Ticket.
    expect(ticketDecisionForTurn(undefined, ticketMeta(PROSE_BRIEF)).kind).toBe("refused");
    // The turn's own Ticket wins when it states one.
    expect(ticketDecisionForTurn(ticketMeta(EXECUTABLE_BRIEF), ticketMeta(PROSE_BRIEF)).kind)
      .toBe("handoff");
  });

  it("answers absent for an ordinary prompt turn and for a malformed shape", () => {
    expect(ticketDecisionForTurn(undefined, undefined).kind).toBe("absent");
    expect(ticketDecisionForTurn({ redskills: { ticket: "not-an-object" } }, undefined).kind)
      .toBe("absent");
    expect(ticketDecisionForTurn({ redskills: { ticket: { number: 5 } } }, undefined).kind)
      .toBe("absent");
  });
});

describe("the refusal the turn answers with", () => {
  it("is a terminal Ticket verdict, not a completion", () => {
    const response = briefRefusalResponse("brief contract refused: item is not machine-checkable");
    expect(response.stopReason).toBe("end_turn");
    expect(response._meta).toEqual({
      redskills: {
        ticket: {
          outcome: "refused",
          stage: TICKET_BRIEF_REFUSAL_STAGE,
          detail: "brief contract refused: item is not machine-checkable",
        },
      },
    });
    // Only a landed Ticket is a completion; naming this one would tell the
    // daemon to close a Ticket nothing shipped.
    expect((response._meta as { redskills: Record<string, unknown> }).redskills)
      .not.toHaveProperty("workflowOutcome");
  });
});

describe("the Worker body, driven across a real ACP connection", () => {
  const roots: string[] = [];
  const servers: Server[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await closeServer(server);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  /** One request against the Worker, typed only where the assertions look. */
  type WorkerRequest = (method: string, params: unknown) => Promise<{
    readonly sessionId?: string;
    readonly stopReason?: string;
    readonly _meta?: unknown;
  }>;

  async function connectWorker(): Promise<{
    readonly cwd: string;
    readonly request: WorkerRequest;
    readonly updates: unknown[];
    readonly published: unknown[];
    readonly finish: () => Promise<void>;
  }> {
    const root = await mkdtemp(join(tmpdir(), "worker-brief-refusal-"));
    roots.push(root);
    const socketPath = join(root, "worker.sock");
    const rendezvous = await bindWorkerRendezvous(socketPath);
    servers.push(rendezvous.server);
    // The child endpoint is never reached on either path under test: a refused
    // brief ends before the loop, and the echo path spawns nothing.
    const worker = runNativeAcpWorker(socketPath, {
      agent: "redcode",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const socket = await rendezvous.connected;
    sockets.push(socket);
    rendezvous.server.close();

    const updates: unknown[] = [];
    const published: unknown[] = [];
    const parent = client({ name: "stub parent" })
      .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
      .onRequest(
        REDSKILLS_ACP_METHODS.publish,
        (value: unknown) => value as never,
        ({ params }) => {
          published.push(params);
          return { receipt: "stub" };
        },
      );
    const connection = parent.connect(socketStream(socket));
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "stub parent", version: "1" },
      _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
    });
    return {
      cwd: root,
      // Bound: the SDK's `request` reaches for its own connection state, and a
      // detached method reference loses it.
      request: ((method, params) =>
        connection.agent.request(method as never, params as never)) as WorkerRequest,
      updates,
      published,
      finish: async () => {
        connection.close();
        socket.destroy();
        await worker;
        await removeAcpEndpoint(socketPath);
      },
    };
  }

  it("refuses the turn, naming the contract's sentence, and publishes nothing", async () => {
    const worker = await connectWorker();
    try {
      const session = await worker.request(methods.agent.session.new, {
        cwd: worker.cwd,
        mcpServers: [],
      });
      const response = await worker.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "work the ticket" }],
        _meta: ticketMeta(PROSE_BRIEF),
      });

      expect(response.stopReason).toBe("end_turn");
      const ticket = (response._meta as { redskills?: { ticket?: Record<string, unknown> } })
        ?.redskills?.ticket;
      expect(ticket?.outcome).toBe("refused");
      expect(ticket?.stage).toBe("brief");
      expect(String(ticket?.detail)).toContain(
        "brief contract refused: missing acceptance-criteria section",
      );
      // The sentence is in the transcript too, so a Worker log holds it after
      // the process is gone.
      const said = worker.updates
        .map((update) => (update as {
          update?: { content?: { text?: string } };
        }).update?.content?.text ?? "")
        .join("");
      expect(said).toContain("brief contract refused");
      // Nothing was claimed, gated or committed, so nothing may reach a remote.
      expect(worker.published).toHaveLength(0);
    } finally {
      await worker.finish();
    }
  }, 30_000);

  it("leaves an absent handoff on the legal prompt path, unchanged", async () => {
    const worker = await connectWorker();
    try {
      const session = await worker.request(methods.agent.session.new, {
        cwd: worker.cwd,
        mcpServers: [],
      });
      const response = await worker.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "complete workflow" }],
      });

      expect(response.stopReason).toBe("end_turn");
      const meta = (response._meta as { redskills?: Record<string, unknown> })?.redskills;
      expect(meta?.workflowOutcome).toBe("completion");
      expect(meta?.ticket).toBeUndefined();
      const said = worker.updates
        .map((update) => (update as {
          update?: { content?: { text?: string } };
        }).update?.content?.text ?? "")
        .join("");
      expect(said).toContain("native Worker completed: complete workflow");
    } finally {
      await worker.finish();
    }
  }, 30_000);
});
