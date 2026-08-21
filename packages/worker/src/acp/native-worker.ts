/**
 * The native ACP Workflow Worker: everything that runs INSIDE the process.
 *
 * redskilled decides that this Worker should exist, binds its rendezvous
 * socket, launches it and reaps it. From the moment the process is running,
 * what it does with its turn — the child Agent it delegates to, the plan and
 * message chunks it emits, the permission it asks its parent for, the
 * cancellation it honours — is body, and lives here (ADR 0148).
 */
import { randomUUID } from "node:crypto";
import {
  agent,
  methods,
  type AgentContext,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  ACP_PROTOCOL_VERSION,
  REDSKILLS_WIRE_MAJOR,
  abortableDelay,
  connectWithDeadline,
  notifySessionRecovery,
  requireCompatibleWireMajor,
  sessionRecoveryFromMeta,
  socketStream,
  ticketHandoffFromMeta,
  waitForAbort,
  withTimeout,
  type AcpEndpoint,
  type AcpSessionRecoveryCheckpoint,
  type RedskillsTicketHandoff,
} from "@reddb-io/protocol-acp";
import { WorkflowChildAgent } from "./child-agent.js";
import { acquireHostGateLock } from "./gate-lock.js";
import { runWorkerLocalGate } from "./local-gate.js";
import { createWorkerPublisher, worktreeHead, type WorkerPublisher } from "./publish-request.js";
import { runTicketLoop, type TicketLoopRecord, type TicketLoopResult } from "./ticket-loop.js";

/** One public session this Worker holds, and what it retains across its turns. */
interface HeldSession {
  readonly request: NewSessionRequest;
  child?: WorkflowChildAgent;
  publisher?: WorkerPublisher;
}

/** The daemon-admitted native Workflow Worker. */
export async function runNativeAcpWorker(socketPath: string, childEndpoint: AcpEndpoint): Promise<number> {
  const controllers = new Map<string, AbortController>();
  const sessions = new Map<string, HeldSession>();
  const recoveries = new Map<string, AcpSessionRecoveryCheckpoint>();
  /**
   * Ask the parent to publish what this turn committed, at most once per turn.
   *
   * A cancelled turn publishes nothing: cancellation is the one outcome where
   * the commit in the Worktree may be mid-thought, and publishing it would put
   * an abandoned state on the Project remote under the branch's name.
   */
  async function publishAfterTurn(
    sessionId: string,
    parent: AgentContext,
    response: PromptResponse,
  ): Promise<void> {
    if (response.stopReason === "cancelled") return;
    // A Ticket turn already decided about publication, and its answer includes
    // the refusals: a lane the Worker may not claim and a gate that blocked
    // both end with a commit in the Worktree that must reach no remote. Asking
    // again here would publish precisely the work the loop refused.
    if (ticketOutcome(response) != null) return;
    const held = sessions.get(sessionId);
    if (held == null) return;
    const heldTicket = ticketHandoffFromMeta(held.request._meta);
    held.publisher ??= createWorkerPublisher({
      cwd: held.request.cwd,
      idempotencyScope: `worker-turn:${sessionId}`,
      request: boundedRequest(parent),
      // The publication owns its branch: Worker-unique, so it can never target
      // the trunk and never collide with a merged branch's corpse (#4157).
      ...(heldTicket == null ? {} : { publishRef: `red/${heldTicket.worker_id}/${heldTicket.number}` }),
    });
    const outcome = await held.publisher.publishTurn();
    if (outcome == null) return;
    await parent.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
      _meta: {
        redskills: {
          lifecycle: { event: `publication-${outcome.status}` },
          publication: {
            branch: outcome.publication.branch,
            commit: outcome.publication.commit,
            ...(outcome.status === "refused" ? { detail: outcome.detail } : {}),
          },
        },
      },
    });
  }

  /**
   * One Ticket turn: the whole loop, inside the process the daemon admitted.
   *
   * The child Agent and the publisher are the SESSION's, not the round's — a
   * re-seed re-instructs the implementer that is already holding the Worktree,
   * and the publisher that remembers what it already asked for is what keeps a
   * second round from publishing the first round's commit twice (ADR 0129).
   */
  async function runTicketTurn(
    sessionId: string,
    held: HeldSession,
    ticket: RedskillsTicketHandoff,
    parent: AgentContext,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const child = held.child ??= new WorkflowChildAgent({
      endpoint: childEndpoint,
      cwd: held.request.cwd,
      mcpServers: held.request.mcpServers,
      ...(held.request.additionalDirectories == null
        ? {}
        : { additionalDirectories: held.request.additionalDirectories }),
      publicSessionId: sessionId,
      parent,
    });
    held.publisher ??= createWorkerPublisher({
      cwd: held.request.cwd,
      idempotencyScope: `worker-turn:${sessionId}`,
      request: boundedRequest(parent),
      // Same Worker-unique publication branch as the budget-grace path.
      publishRef: `red/${ticket.worker_id}/${ticket.number}`,
      // Captured BEFORE the implementer runs: a turn that commits nothing must
      // answer nothing-to-publish, not publish main's own tip (#4157).
      ...(await worktreeHead(held.request.cwd).then(
        (commit) => (commit == null ? {} : { baselineCommit: commit }),
      )),
    });

    const result = await runTicketLoop({
      ticket: {
        number: ticket.number,
        title: ticket.title,
        labels: ticket.labels,
        base: ticket.base,
        handoff: ticket.handoff,
      },
      workerId: ticket.worker_id,
      sessionId,
      ...(ticket.runner == null ? {} : { runner: ticket.runner }),
      ...(ticket.run_mode == null ? {} : { runMode: ticket.run_mode }),
      ...(ticket.reseed_budget == null ? {} : { reseedBudget: ticket.reseed_budget }),
      request: boundedRequest(parent),
      implement: async (handoff) => {
        if (signal.aborted) return { stopReason: "cancelled" };
        const response = await child.prompt({
          sessionId,
          prompt: [{ type: "text", text: handoff }],
        });
        return { stopReason: response.stopReason };
      },
      gate: async () => {
        // #4161: one Validation execution at a time per host — two concurrent
        // gates read each other's contention as branch fault.
        const slot = await acquireHostGateLock({
          onWait: (holder, waitedMs) => void notifyTicketStage(parent, sessionId, {
            stage: "gate",
            ok: true,
            detail: `waiting for the host gate slot (${Math.round(waitedMs / 1000)}s` +
              `${holder == null ? "" : `, held by pid ${holder}`})`,
          }),
        });
        try {
          return await runWorkerLocalGate({
            worktree: held.request.cwd,
            base: ticket.base,
            ...(ticket.backpressure_commands == null
              ? {}
              : { backpressureCommands: ticket.backpressure_commands }),
            ...(ticket.validation_commands == null
              ? {}
              : { validationCommands: ticket.validation_commands }),
          });
        } finally {
          await slot.release();
        }
      },
      publisher: held.publisher,
      narrate: (record) => notifyTicketStage(parent, sessionId, record),
    });
    return ticketResponse(result);
  }

  async function runPromptTurn(
    params: PromptRequest,
    parent: AgentContext,
  ): Promise<PromptResponse> {
    const held = sessions.get(params.sessionId);
    if (held == null) throw new Error("unknown native Worker ACP session");
    const controller = new AbortController();
    controllers.set(params.sessionId, controller);
    try {
      const recovery = recoveries.get(params.sessionId);
      if (recovery != null) {
        recoveries.delete(params.sessionId);
        await notifySessionRecovery(parent, params.sessionId, recovery);
      }
      const ticket = ticketHandoffFromMeta(params._meta) ?? ticketHandoffFromMeta(held.request._meta);
      if (ticket != null) {
        return await runTicketTurn(params.sessionId, held, ticket, parent, controller.signal);
      }
      const prompt = promptText(params);
      if (prompt.includes("delegate child")) {
        held.child ??= new WorkflowChildAgent({
          endpoint: childEndpoint,
          cwd: held.request.cwd,
          mcpServers: held.request.mcpServers,
          ...(held.request.additionalDirectories == null
            ? {}
            : { additionalDirectories: held.request.additionalDirectories }),
          publicSessionId: params.sessionId,
          parent,
        });
        return await held.child.prompt(params);
      }
      await parent.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Execute the prompt inside the admitted native Worker", priority: "high", status: "in_progress" }],
        },
      });
      await parent.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "native Worker is executing the prompt\n" },
        },
        _meta: { redskills: { lifecycle: { event: "tool-activity" } } },
      });
      let permissionResolution: string | undefined;
      if (prompt.includes("permission")) {
        // The delay gives the public launch-edge transport time to disappear;
        // policy resolution remains daemon-owned after it does.
        await abortableDelay(75, controller.signal);
        const title = prompt.includes("denial")
          ? "denied operation"
          : prompt.includes("uncovered")
            ? "uncovered operation"
            : "governed write";
        const permission = await parent.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: randomUUID(),
            title,
            kind: "edit",
            status: "pending",
          },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        permissionResolution = (permission._meta as {
          redskills?: { permissionResolution?: string };
        } | undefined)?.redskills?.permissionResolution;
        if (permission.outcome.outcome === "cancelled" || permissionResolution === "hitl-required") {
          return {
            stopReason: "cancelled",
            _meta: { redskills: { permissionResolution, workflowOutcome: "permission-hitl" } },
          } satisfies PromptResponse;
        }
        const chosen = permission.outcome.optionId;
        if (chosen === "reject") {
          return {
            stopReason: "end_turn",
            _meta: { redskills: { permissionResolution } },
          } satisfies PromptResponse;
        }
      }
      if (prompt.includes("wait for cancellation")) {
        await waitForAbort(controller.signal);
      } else {
        await abortableDelay(35, controller.signal);
      }
      if (controller.signal.aborted) {
        await parent.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "native Worker cancelled the prompt\n" },
          },
        });
        return { stopReason: "cancelled" } satisfies PromptResponse;
      }

      await parent.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Execute the prompt inside the admitted native Worker", priority: "high", status: "completed" }],
        },
      });
      await parent.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `native Worker completed: ${prompt}\n` },
        },
      });
      const workflowOutcome = prompt.includes("complete workflow")
        ? "completion"
        : prompt.includes("budget verdict")
          ? "budget-verdict"
          : prompt.includes("replace worker")
            ? "replacement"
            : prompt.includes("explicit control")
              ? "explicit-control"
              : undefined;
      return {
        stopReason: "end_turn",
        ...(workflowOutcome == null && permissionResolution == null
          ? {}
          : { _meta: { redskills: { workflowOutcome, permissionResolution } } }),
      } satisfies PromptResponse;
    } finally {
      controllers.delete(params.sessionId);
    }
  }

  const app = agent({ name: "RedSkills native Worker" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      requireCompatibleWireMajor(params._meta, true);
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: {} },
        agentInfo: { name: "RedSkills native Worker", version: "1" },
        _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR, worker: true } },
      };
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      const sessionId = randomUUID();
      sessions.set(sessionId, { request: params });
      const recovery = sessionRecoveryFromMeta(params._meta);
      if (recovery != null) recoveries.set(sessionId, recovery);
      return {
        sessionId,
        _meta: {
          redskills: {
            sessionEvidence: {
              provider: "redskills-native",
              availability: "absent",
            },
          },
        },
      };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client: parent }) => {
      const response = await runPromptTurn(params, parent);
      // The turn is over, so the publication request is the LAST thing the
      // Worker does with it: the inner agent was refused `git push` on the way
      // in, and this is the promise that refusal made (ADR 0148).
      await publishAfterTurn(params.sessionId, parent, response);
      return response;
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      controllers.get(params.sessionId)?.abort();
      await sessions.get(params.sessionId)?.child?.cancel(params._meta);
    });

  const socket = await connectWithDeadline(socketPath, 10_000);
  const connection = app.connect(socketStream(socket));
  await connection.closed;
  for (const session of sessions.values()) session.child?.close();
  return 0;
}

function promptText(params: PromptRequest): string {
  return params.prompt
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Narrate one Ticket stage to the parent, so the Worker log holds the arc.
 *
 * An empty message chunk carrying `_meta` rather than prose: the stage record
 * is for the daemon's lane, and a Worker that also spoke it as text would put
 * its own bookkeeping in the transcript the human reads.
 */
function notifyTicketStage(
  parent: AgentContext,
  sessionId: string,
  record: TicketLoopRecord,
): Promise<void> {
  return parent.notify(methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    _meta: {
      redskills: {
        lifecycle: { event: `ticket-${record.stage}-${record.ok ? "passed" : "blocked"}` },
        ticketStage: {
          stage: record.stage,
          ok: record.ok,
          ...(record.round == null ? {} : { round: record.round }),
          ...(record.detail == null ? {} : { detail: record.detail }),
        },
      },
    },
  });
}

/**
 * How long a Worker waits for the daemon to answer one request.
 *
 * **A Worker waiting on the daemon has a deadline, or it is a Worker doing
 * nothing.** The Ticket loop claims, publishes and lands by ASKING the daemon —
 * a Worker holds no credential (ADR 0144 §3) — and those asks were unbounded.
 * On 2026-08-20 five Workers sat alive for eleven minutes each on a pending
 * claim: no branch, no narration, no claim comment, 15 seconds of CPU between
 * them, and every liveness surface reporting them healthy. An unbounded wait
 * inside a Worker is the orphan-poll shape the repo already refuses in its own
 * engine (`DECLARED_WAITS`), and it looks exactly like work.
 *
 * Generous on purpose: a forge write behind a cold credential is slow, not
 * broken. What the deadline buys is that a stall ENDS, and ends saying so.
 */
export const WORKER_REQUEST_DEADLINE_MS = 120_000;

/**
 * Ask the daemon, bounded, and name the method when the deadline passes so the
 * refusal an operator reads says which ask went unanswered.
 */
function boundedRequest(
  parent: AgentContext,
): (method: string, params: unknown) => Promise<unknown> {
  return (method, params) => withTimeout(
    parent.request(method, params),
    WORKER_REQUEST_DEADLINE_MS,
    `the daemon did not answer ${method}`,
  );
}

/**
 * The turn's answer, carrying the loop's own verdict.
 *
 * Only a LANDED Ticket is a completion: a gate that blocked, a refusal and a
 * Worktree with nothing in it are all ordinary ends of a turn, and calling any
 * of them "complete" would tell the daemon to close a Ticket nothing shipped.
 */
function ticketResponse(result: TicketLoopResult): PromptResponse {
  const ticket = result.outcome === "landed"
    ? {
        outcome: result.outcome,
        rounds: result.rounds,
        pullRequest: result.pullRequest,
        branch: result.publication.branch,
        commit: result.publication.commit,
      }
    : result.outcome === "gate-blocked"
      ? { outcome: result.outcome, rounds: result.rounds, failedStage: result.failedStage, detail: result.detail }
      : result.outcome === "refused"
        ? { outcome: result.outcome, stage: result.stage, detail: result.detail }
        : { outcome: result.outcome, rounds: result.rounds };
  return {
    stopReason: result.outcome === "cancelled" ? "cancelled" : "end_turn",
    _meta: {
      redskills: {
        ticket,
        ...(result.outcome === "landed" ? { workflowOutcome: "completion" } : {}),
      },
    },
  } satisfies PromptResponse;
}

/** The Ticket verdict a turn carries, or `undefined` for an ordinary turn. */
function ticketOutcome(response: PromptResponse): unknown {
  return (response._meta as { redskills?: { ticket?: unknown } } | undefined)?.redskills?.ticket;
}
