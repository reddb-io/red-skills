import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { Socket, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type RequestPermissionRequest,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { socketAnswers } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { requestWorkflowTurn, type ActiveWorkflowWorker } from "../src/acp-worker-lifecycle.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");
const children: ChildProcess[] = [];
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ACP Workflow Worker replacement authority", () => {
  it("does not replace or replay when a live Worker returns a semantic ACP error", async () => {
    const publicSessionId = "public-session";
    const semanticError = RequestError.invalidRequest("the live Worker refused this prompt");
    let promptRequests = 0;
    let replacementAdmissions = 0;
    const worker = {
      workerId: "worker-one",
      downstreamSessionId: "downstream-session",
      connection: {
        agent: {
          request: async () => {
            promptRequests += 1;
            throw semanticError;
          },
        },
        close: () => undefined,
      },
      socket: new Socket(),
      endpoint: "unused-test-endpoint",
      publicSessionId,
      notify: async () => undefined,
      cancelled: false,
      cleaned: false,
    } as unknown as ActiveWorkflowWorker;
    const active = new Map([[publicSessionId, worker]]);

    await expect(requestWorkflowTurn(
      publicSessionId,
      active,
      { sessionId: publicSessionId, prompt: [{ type: "text", text: "perform one semantic request" }] },
      async () => {
        replacementAdmissions += 1;
        throw new Error("a healthy Worker must not be replaced");
      },
    )).rejects.toBe(semanticError);

    expect(promptRequests).toBe(1);
    expect(replacementAdmissions).toBe(0);
    expect(active.get(publicSessionId)).toBe(worker);
    expect(worker.cleaned).toBe(false);
  });
});

describe("the public RedSkills ACP v1 control plane", () => {
  it("governs a nested child Agent through the public workflow session", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-child-agent-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
      REDSKILLED_ACP_PERMISSION_TIMEOUT_MS: "500",
      PATH: `${resolve(__dirname, "fixtures", "bin")}:${process.env.PATH ?? ""}`,
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const adapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const updates: SessionNotification[] = [];
    const permissionRequests: RequestPermissionRequest[] = [];
    const connection = client({ name: "redskilled-nested-agent-test" })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return { outcome: { outcome: "selected", optionId: "once" } };
      })
      .connect(childStream(adapter));
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "nested-agent-client", version: "1" },
    });
    const session = await connection.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });

    const delegated = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "delegate child permission workflow" }],
    });
    expect(delegated).toMatchObject({
      stopReason: "end_turn",
      _meta: {
        redskills: {
          childAgent: "redcode",
          childAttempts: 1,
          delegation: {
            authority: "parent-worker",
            budget: "parent-remaining",
            cancellation: "parent-mediated",
            permissions: "parent-mediated",
          },
        },
      },
    });
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.sessionId).toBe(session.sessionId);
    expect(new Set(updates.map((update) => update.sessionId))).toEqual(new Set([session.sessionId]));
    expect(updates.map(lifecycleEvent).filter(Boolean)).toContain("child-admission");

    for (const pattern of [
      "repeated-action-observation",
      "error-streak",
      "monologue",
      "alternating-ping-pong",
    ]) {
      updates.length = 0;
      const spun = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: `delegate child spin ${pattern}` }],
      });
      expect(workflowOutcome(spun._meta)).toBe(`spin:${pattern}`);
      const spinLifecycle = updates.map(lifecycleMeta).filter((entry) => entry?.event.startsWith("child-spin"));
      expect(spinLifecycle).toEqual([
        expect.objectContaining({ event: "child-spin-detected", pattern }),
        expect.objectContaining({ event: "child-spin-steer", pattern }),
        expect.objectContaining({ event: "child-spin-persistent", pattern }),
      ]);
      expect(spinLifecycle.every((entry) => entry != null && !("reasoning" in entry))).toBe(true);
    }

    updates.length = 0;
    const advancing = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "delegate child spin near-miss" }],
    });
    expect(workflowOutcome(advancing._meta)).toBeUndefined();
    expect(updates.map(lifecycleEvent).filter((event) => event?.startsWith("child-spin"))).toEqual([]);

    updates.length = 0;
    const cancelled = connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "delegate child wait for cancellation" }],
    });
    await waitFor(() => updates.some((update) => lifecycleEvent(update) === "child-tool-activity"), "child activity");
    await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
    await expect(cancelled).resolves.toMatchObject({ stopReason: "cancelled" });

    updates.length = 0;
    await expect(connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "delegate child transport failure" }],
    })).rejects.toThrow();
    expect(updates.map(lifecycleEvent).filter(Boolean)).toEqual([
      "admission",
      "child-admission",
      "child-tool-activity",
      "child-replacement",
      "child-tool-activity",
      "child-failure",
    ]);

    connection.close();
    adapter.stdin?.end();
    daemon.kill("SIGTERM");
  }, 30_000);

  it("replaces a dead Worker and resumes the same public session from its observable journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-replacement-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const adapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const updates: SessionNotification[] = [];
    const acpClient = client({ name: "redskilled-acp-replacement-test" })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const connection = acpClient.connect(childStream(adapter));
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "redskilled-replacement-client", version: "1" },
    });
    const session = await connection.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    const first = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "begin durable workflow" }],
    });
    const firstBirth = await waitForEvent(paths.eventLanePath, "worker-birth", workerId(first._meta));

    process.kill(firstBirth.pid, "SIGKILL");
    await waitForEvent(paths.eventLanePath, "worker-death", firstBirth.worker_id);
    updates.length = 0;

    const continued = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "continue durable workflow" }],
    });
    expect(continued.stopReason).toBe("end_turn");
    expect(workerId(continued._meta)).not.toBe(firstBirth.worker_id);
    expect(updates.map(lifecycleEvent).filter(Boolean)).toEqual([
      "replacement",
      "checkpoint-resume",
      "tool-activity",
    ]);
    expect(new Set(updates.map((update) => update.sessionId))).toEqual(new Set([session.sessionId]));
    expect(updates.filter(agentText).map(agentText).join("\n")).toContain("resumed 1 completed turn");

    const journalPath = join(dirname(paths.registrationIntentPath), "redskilled.acp-sessions.toon");
    const journal = decode(await readFile(journalPath, "utf8")) as unknown as {
      version: number;
      sessions: Array<{
        public_session_id: string;
        entries: Array<{ kind: string }>;
        session_evidence: Array<{
          worker_id: string;
          provider: string;
          availability: string;
          retention: string;
        }>;
        provider_transcript?: unknown;
      }>;
    };
    const durable = journal.sessions.find((entry) => entry.public_session_id === session.sessionId);
    expect(journal.version).toBe(1);
    expect(durable?.entries.map((entry) => entry.kind)).toEqual([
      "prompt",
      "workflow-pointer",
      "plan",
      "plan",
      "checkpoint",
      "prompt",
      "workflow-pointer",
      "plan",
      "plan",
      "checkpoint",
    ]);
    expect(durable?.session_evidence).toEqual([
      {
        worker_id: firstBirth.worker_id,
        provider: "redskills-native",
        availability: "absent",
        retention: "evidence",
      },
      {
        worker_id: workerId(continued._meta),
        provider: "redskills-native",
        availability: "absent",
        retention: "evidence",
      },
    ]);
    expect(durable).not.toHaveProperty("provider_transcript");
    expect(JSON.stringify(durable)).not.toMatch(/chain[-_ ]of[-_ ]thought|agent_thought/i);

    connection.close();
    adapter.stdin?.end();
    daemon.kill("SIGTERM");
  }, 30_000);

  it("replaces a killed /go Worker from the exact journaled Ticket dispatch and refuses an invalid target once", async () => {
    const root = await mkdtemp(join(tmpdir(), "r-acp-retry-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const adapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const updates: SessionNotification[] = [];
    let killedOriginal = false;
    const acpClient = client({ name: "redskilled-targeted-replacement-test" })
      .onNotification(methods.client.session.update, async ({ params }) => {
        updates.push(params);
        const lifecycle = lifecycleMeta(params);
        if (lifecycle?.event !== "admission" || lifecycle.dispatch?.workerKind !== "go" || killedOriginal) return;
        killedOriginal = true;
        const birth = await waitForEvent(paths.eventLanePath, "worker-birth", lifecycle.workerId);
        process.kill(birth.pid, "SIGKILL");
      });
    const connection = acpClient.connect(childStream(adapter));
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "redskilled-targeted-replacement-test", version: "1" },
    });
    const session = await connection.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    const dispatch = {
      version: 1 as const,
      workerKind: "go" as const,
      ticket: 3775,
      selector: { kind: "issues" as const, numbers: [3775], lane: "lane:go" },
    };
    const result = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "complete workflow" }],
      _meta: { redskills: { dispatch } },
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result._meta).toMatchObject({ redskills: { dispatch, replacement: 1 } });

    const lifecycle = updates.map(lifecycleMeta).filter((entry) => entry != null);
    expect(lifecycle.map((entry) => entry.event)).toEqual([
      "admission",
      "death",
      "replacement",
      "checkpoint-resume",
      "tool-activity",
      "terminal-outcome",
      "reaping",
    ]);
    expect(lifecycle.every((entry) => entry.dispatch?.workerKind === "go")).toBe(true);
    expect(lifecycle.every((entry) => entry.dispatch?.ticket === 3775)).toBe(true);
    expect(lifecycle.every((entry) => entry.dispatch?.selector.lane === "lane:go")).toBe(true);
    expect(lifecycle.some((entry) => entry.dispatch?.selector.lane === "ready-for-agent")).toBe(false);

    const workerEvents = await waitForEvents(paths.eventLanePath, 3);
    const births = workerEvents.filter((event) => event.kind === "worker-birth");
    const deaths = workerEvents.filter((event) => event.kind === "worker-death");
    expect(births).toHaveLength(2);
    expect(deaths.map((event) => event.worker_id)).toContain(births[0]!.worker_id);
    expect(births[1]!.worker_id).not.toBe(births[0]!.worker_id);

    updates.length = 0;
    const birthsBeforeRefusal = births.length;
    await expect(connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "retry an invalid target" }],
      _meta: {
        redskills: {
          dispatch: {
            version: 1,
            workerKind: "go",
            ticket: 0,
            selector: { kind: "issues", numbers: [0], lane: "lane:go" },
          },
        },
      },
    })).rejects.toThrow(/positive Ticket number/);
    expect(updates.map(lifecycleEvent).filter(Boolean)).toEqual(["refusal"]);
    const afterRefusal = await readRedskilledEvents(paths.eventLanePath);
    expect(afterRefusal.filter((event) => event.kind === "worker-birth")).toHaveLength(birthsBeforeRefusal);

    connection.close();
    adapter.stdin?.end();
    daemon.kill("SIGTERM");
  }, 30_000);

  it("reuses one bounded Workflow Worker across related turns and reaps every terminal outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-control-plane-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
      REDSKILLED_ACP_WORKER_IDLE_MS: "100",
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const adapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const updates: SessionNotification[] = [];
    const acpClient = client({ name: "redskilled-acp-control-plane-test" })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const connection = acpClient.connect(childStream(adapter));

    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "redskilled-test-client", version: "1" },
    });
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.agentInfo?.name).toBe("RedSkills");

    const session = await connection.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    const project = projectMeta(session._meta);
    const first = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "start the native tracer" }],
    });
    const second = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "continue the native tracer" }],
    });
    expect(first.stopReason).toBe("end_turn");
    expect(workerId(first._meta)).toBe(workerId(second._meta));
    expect(updates.map((entry) => entry.update.sessionUpdate)).toContain("plan");
    expect(updates.map(lifecycleEvent).filter(Boolean)).toEqual(["admission", "tool-activity", "tool-activity"]);

    const firstBirth = await waitForEvent(paths.eventLanePath, "worker-birth");
    expect(firstBirth.project_label).toBe(project.projectId);
    expect(firstBirth.workspace_path).toBe(project.workspacePath);
    expect(firstBirth.pid).toBeGreaterThan(0);
    const liveBetweenTurns = await connection.agent.request<{ workers: Array<{ worker_id: string }> }>(
      "_redskills/host_state",
      {},
    );
    expect(liveBetweenTurns.workers.map((worker) => worker.worker_id)).toContain(firstBirth.worker_id);
    await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "complete workflow" }],
    });
    const firstDeath = await waitForEvent(paths.eventLanePath, "worker-death", firstBirth.worker_id);
    expect(Date.parse(firstDeath.ts)).toBeGreaterThanOrEqual(Date.parse(firstBirth.ts));
    expect(updates.map(lifecycleEvent).filter(Boolean).slice(-3)).toEqual([
      "tool-activity", "terminal-outcome", "reaping",
    ]);

    updates.length = 0;
    const cancelledPrompt = connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait for cancellation" }],
    });
    await waitFor(
      () => updates.some((entry) => entry.update.sessionUpdate === "agent_message_chunk"),
      "Worker progress before cancellation",
    );
    await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
    await expect(cancelledPrompt).resolves.toMatchObject({ stopReason: "cancelled" });

    const events = await waitForEvents(paths.eventLanePath, 4);
    const births = events.filter((event) => event.kind === "worker-birth");
    const deaths = events.filter((event) => event.kind === "worker-death");
    expect(births).toHaveLength(2);
    expect(deaths).toHaveLength(2);
    expect(new Set(deaths.map((event) => event.worker_id))).toEqual(new Set(births.map((event) => event.worker_id)));

    for (const terminal of ["budget verdict", "replace worker", "explicit control"] as const) {
      updates.length = 0;
      const result = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: terminal }],
      });
      const id = workerId(result._meta);
      await waitForEvent(paths.eventLanePath, "worker-death", id);
      expect(updates.map(lifecycleEvent).filter(Boolean).slice(-2)).toEqual(["terminal-outcome", "reaping"]);
    }

    updates.length = 0;
    const idle = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "pause between related turns" }],
    });
    await waitForEvent(paths.eventLanePath, "worker-death", workerId(idle._meta));
    expect(updates.map(lifecycleEvent).filter(Boolean).at(-1)).toBe("reaping");

    connection.close();
    adapter.stdin?.end();
    daemon.kill("SIGTERM");
  }, 30_000);

  it("projects attached permission decisions and resolves detached requests without an immortal Worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-permissions-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
      REDSKILLED_ACP_PERMISSION_TIMEOUT_MS: "100",
      REDSKILLED_ACP_WORKER_IDLE_MS: "100",
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const adapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const updates: SessionNotification[] = [];
    const permissionRequests: RequestPermissionRequest[] = [];
    const connection = client({ name: "redskilled-acp-permission-test" })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        permissionRequests.push(params);
        return {
          outcome: {
            outcome: "selected",
            optionId: params.toolCall.title?.includes("denied") === true ? "reject" : "always",
          },
        };
      })
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .connect(childStream(adapter));
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "redskilled-permission-client", version: "1" },
    });
    const session = await connection.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });

    const approved = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "request permission attached approval" }],
    });
    expect(permissionRequests).toHaveLength(1);
    expect(permissionResolution(approved._meta)).toBe("attached-approved");

    const denied = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "request permission attached denial" }],
    });
    expect(permissionResolution(denied._meta)).toBe("attached-denied");
    expect(permissionRequests.map((request) => request.toolCall.title)).toEqual([
      "governed write",
      "denied operation",
    ]);

    updates.length = 0;
    void connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "request permission detached pre-authorization" }],
    }).catch(() => undefined);
    await waitFor(() => updates.some((update) => lifecycleEvent(update) === "tool-activity"), "detached turn start");
    connection.close();
    adapter.stdin?.end();

    const journalPath = join(dirname(paths.registrationIntentPath), "redskilled.acp-sessions.toon");
    await waitFor(
      async () => (await permissionDecisions(journalPath, session.sessionId)).includes("policy-pre-authorized"),
      "detached policy decision",
    );

    const uncoveredAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const uncoveredUpdates: SessionNotification[] = [];
    const uncovered = client({ name: "redskilled-acp-uncovered-test" })
      .onNotification(methods.client.session.update, ({ params }) => {
        uncoveredUpdates.push(params);
      })
      .connect(childStream(uncoveredAdapter));
    await uncovered.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "redskilled-uncovered-client", version: "1" },
    });
    const uncoveredSession = await uncovered.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    void uncovered.agent.request(methods.agent.session.prompt, {
      sessionId: uncoveredSession.sessionId,
      prompt: [{ type: "text", text: "request permission detached uncovered decision" }],
    }).catch(() => undefined);
    await waitFor(
      () => uncoveredUpdates.some((update) => lifecycleEvent(update) === "tool-activity"),
      "uncovered turn start",
    );
    uncovered.close();
    uncoveredAdapter.stdin?.end();

    await waitFor(
      async () => (await permissionDecisions(journalPath, uncoveredSession.sessionId)).includes("hitl-required"),
      "durable HITL permission fact",
    );
    await waitFor(async () => {
      const events = await readRedskilledEvents(paths.eventLanePath);
      const births = events.filter((event) => event.kind === "worker-birth");
      const deaths = events.filter((event) => event.kind === "worker-death");
      return births.length === deaths.length && births.length >= 2;
    }, "detached Worker reaping");

    daemon.kill("SIGTERM");
  }, 30_000);

  it("maps clones and a rename to one clean canonical Project workspace and bounds client authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-project-"));
    roots.push(root);
    const remote = join(root, "acme", "widgets.git");
    const firstCheckout = join(root, "client-a");
    const secondCheckout = join(root, "client-b");
    git(root, "init", "--bare", remote);
    git(root, "clone", remote, firstCheckout);
    git(firstCheckout, "config", "user.email", "fixture@example.invalid");
    git(firstCheckout, "config", "user.name", "Fixture");
    await writeFile(join(firstCheckout, "tracked.txt"), "committed\n");
    git(firstCheckout, "add", "tracked.txt");
    git(firstCheckout, "commit", "-m", "fixture");
    git(firstCheckout, "push", "origin", "HEAD");
    git(root, "clone", remote, secondCheckout);
    await writeFile(join(firstCheckout, "tracked.txt"), "dirty editor state\n");
    await writeFile(join(firstCheckout, "untracked.txt"), "must not cross\n");

    const github = createServer((request, response) => {
      const other = request.url?.endsWith("/acme/other") === true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: other ? 9002 : 9001,
        node_id: other ? "R_other" : "R_widgets",
        full_name: other ? "acme/other" : "acme/renamed-widgets",
      }));
    });
    servers.push(github);
    await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
    const githubOrigin = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
      REDSKILLED_HOST_TOKEN: "fixture-token",
      GITHUB_API_URL: githubOrigin,
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const firstAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const first = client({ name: "project-client-a" }).connect(childStream(firstAdapter));
    await first.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "project-client-a", version: "1" },
    });
    const firstSession = await first.agent.request(methods.agent.session.new, {
      cwd: firstCheckout,
      mcpServers: [],
    });
    const firstProject = projectMeta(firstSession._meta);
    expect(firstProject.projectId).toBe("github:9001");
    expect(firstProject.projectLabel).toBe("acme/renamed-widgets");
    expect(firstProject.workspacePath).not.toBe(firstCheckout);
    expect(await readFile(join(firstProject.workspacePath, "tracked.txt"), "utf8")).toBe("committed\n");
    await expect(readFile(join(firstProject.workspacePath, "untracked.txt"), "utf8")).rejects.toThrow();
    await first.agent.request(methods.agent.session.prompt, {
      sessionId: firstSession.sessionId,
      prompt: [{ type: "text", text: "observe the canonical Project" }],
    });
    const projectBirth = await waitForEvent(paths.eventLanePath, "worker-birth");
    expect(projectBirth.project_label).toBe(firstProject.projectId);
    expect(projectBirth.workspace_path).toBe(firstProject.workspacePath);
    const liveScoped = await first.agent.request<{ workers: Array<{ project_label: string }> }>(
      "_redskills/host_state",
      {},
    );
    expect(liveScoped.workers.map((worker) => worker.project_label)).toEqual([firstProject.projectId]);

    const secondAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const second = client({ name: "project-client-b" }).connect(childStream(secondAdapter));
    await second.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "project-client-b", version: "1" },
    });
    const secondSession = await second.agent.request(methods.agent.session.new, {
      cwd: secondCheckout,
      mcpServers: [],
    });
    expect(projectMeta(secondSession._meta)).toEqual(firstProject);

    git(secondCheckout, "remote", "set-url", "origin", "https://github.invalid/acme/renamed-widgets.git");
    const renamedAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const renamed = client({ name: "project-client-renamed" }).connect(childStream(renamedAdapter));
    await renamed.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "project-client-renamed", version: "1" },
    });
    const renamedSession = await renamed.agent.request(methods.agent.session.new, {
      cwd: secondCheckout,
      mcpServers: [],
    });
    expect(projectMeta(renamedSession._meta)).toEqual(firstProject);

    const other = join(root, "other");
    git(root, "init", other);
    git(other, "remote", "add", "origin", "https://github.invalid/acme/other.git");
    await expect(first.agent.request(methods.agent.session.new, { cwd: other, mcpServers: [] })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/different Project/),
    });
    first.close();
    second.close();
    renamed.close();
    firstAdapter.stdin?.end();
    secondAdapter.stdin?.end();
    renamedAdapter.stdin?.end();
    daemon.kill("SIGTERM");
  }, 30_000);

  it("keeps one governed Project drain alive across clients until an explicit stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-project-drain-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_PLACEMENT: "off",
      REDSKILLED_SESSION: `test:${root}`,
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    let daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "redskilled daemon socket");

    const firstAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const orderedCoreUpdates: string[] = [];
    const first = client({ name: "project-drain-core" })
      .onNotification(methods.client.session.update, ({ params }) => {
        orderedCoreUpdates.push(params.update.sessionUpdate);
      })
      .connect(childStream(firstAdapter));
    const initialized = await first.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "project-drain-core", version: "1" },
    });
    expect(initialized._meta).toMatchObject({
      redskills: {
        projectControl: {
          version: 1,
          methods: ["_redskills/project_drain", "_redskills/project_stop", "_redskills/project_status"],
        },
      },
    });
    const firstSession = await first.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    const coreDrain = await first.agent.request(methods.agent.session.prompt, {
      sessionId: firstSession.sessionId,
      prompt: [{ type: "text", text: "/drain" }],
    });
    expect(projectControlMeta(coreDrain._meta)).toMatchObject({
      drain_intent: "draining",
      revision: 1,
      updates: [{ sequence: 1, operation: "drain", drain_intent: "draining" }],
    });
    expect(orderedCoreUpdates).toEqual(["plan", "agent_message_chunk"]);

    first.close();
    firstAdapter.stdin?.end();

    const firstDaemonExit = new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
    daemon.kill("SIGTERM");
    await firstDaemonExit;
    daemon = launchCli([
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--machine-claim", paths.machineClaimPath,
      "--idle-ms", "60000",
    ], env, ["ignore", "ignore", "pipe"]);
    await waitFor(() => socketAnswers(paths.socketPath, 1_000), "replacement redskilled daemon socket");

    const secondAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const second = client({ name: "project-drain-typed" }).connect(childStream(secondAdapter));
    await second.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "project-drain-typed", version: "1" },
    });
    await second.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    const observed = await second.agent.request<ProjectControlSnapshot>("_redskills/project_status", {});
    expect(observed).toEqual(projectControlMeta(coreDrain._meta));

    const stopped = await second.agent.request<ProjectControlSnapshot>("_redskills/project_stop", {});
    expect(stopped).toMatchObject({
      drain_intent: "stopped",
      revision: 2,
      updates: [
        { sequence: 1, operation: "drain", drain_intent: "draining" },
        { sequence: 2, operation: "stop", drain_intent: "stopped" },
      ],
    });
    second.close();
    secondAdapter.stdin?.end();

    const thirdAdapter = launchCli(["acp"], env, ["pipe", "pipe", "pipe"]);
    const third = client({ name: "project-drain-core-again" }).connect(childStream(thirdAdapter));
    await third.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "project-drain-core-again", version: "1" },
    });
    const thirdSession = await third.agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
    const coreDrainAgain = await third.agent.request(methods.agent.session.prompt, {
      sessionId: thirdSession.sessionId,
      prompt: [{ type: "text", text: "/drain" }],
    });
    expect(projectControlMeta(coreDrainAgain._meta)).toMatchObject({
      drain_intent: "draining",
      revision: 3,
      updates: [
        { sequence: 1, operation: "drain", drain_intent: "draining" },
        { sequence: 2, operation: "stop", drain_intent: "stopped" },
        { sequence: 3, operation: "drain", drain_intent: "draining" },
      ],
    });
    expect(await third.agent.request<ProjectControlSnapshot>("_redskills/project_status", {}))
      .toEqual(projectControlMeta(coreDrainAgain._meta));

    third.close();
    thirdAdapter.stdin?.end();
    daemon.kill("SIGTERM");
  }, 30_000);
});

interface ProjectControlSnapshot {
  readonly version: 1;
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly drain_intent: "inactive" | "draining" | "stopped";
  readonly revision: number;
  readonly updates: ReadonlyArray<{
    readonly sequence: number;
    readonly operation: "drain" | "stop";
    readonly drain_intent: "draining" | "stopped";
  }>;
}

function projectControlMeta(meta: unknown): ProjectControlSnapshot {
  const control = (meta as { redskills?: { projectControl?: unknown } } | undefined)
    ?.redskills?.projectControl;
  expect(control).toMatchObject({ version: 1, project_id: expect.any(String) });
  return control as ProjectControlSnapshot;
}

function projectMeta(meta: unknown): { projectId: string; projectLabel: string; workspacePath: string } {
  const project = (meta as { redskills?: unknown } | undefined)?.redskills as
    | { projectId?: unknown; projectLabel?: unknown; workspacePath?: unknown }
    | undefined;
  expect(project).toMatchObject({
    projectId: expect.any(String),
    projectLabel: expect.any(String),
    workspacePath: expect.any(String),
  });
  return {
    projectId: project!.projectId as string,
    projectLabel: project!.projectLabel as string,
    workspacePath: project!.workspacePath as string,
  };
}

function workerId(meta: unknown): string {
  const id = (meta as { redskills?: { workerId?: unknown } } | undefined)?.redskills?.workerId;
  expect(id).toEqual(expect.any(String));
  return id as string;
}

function lifecycleEvent(update: SessionNotification): string | undefined {
  return lifecycleMeta(update)?.event;
}

function lifecycleMeta(update: SessionNotification): {
  readonly event: string;
  readonly workerId: string;
  readonly pattern?: string;
  readonly dispatch?: {
    readonly workerKind: string;
    readonly ticket: number;
    readonly selector: { readonly lane: string };
  };
} | undefined {
  return (update._meta as { redskills?: { lifecycle?: unknown } } | undefined)
    ?.redskills?.lifecycle as ReturnType<typeof lifecycleMeta>;
}

function workflowOutcome(meta: unknown): string | undefined {
  return (meta as { redskills?: { workflowOutcome?: string } } | undefined)
    ?.redskills?.workflowOutcome;
}

function permissionResolution(meta: unknown): string | undefined {
  return (meta as { redskills?: { permissionResolution?: string } } | undefined)
    ?.redskills?.permissionResolution;
}

async function permissionDecisions(path: string, sessionId: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const journal = decode(raw) as unknown as {
    sessions?: Array<{
      public_session_id?: string;
      entries?: Array<{ kind?: string; decision?: string }>;
    }>;
  };
  return journal.sessions
    ?.find((session) => session.public_session_id === sessionId)
    ?.entries?.filter((entry) => entry.kind === "permission")
    .map((entry) => entry.decision ?? "") ?? [];
}

function agentText(update: SessionNotification): string {
  if (update.update.sessionUpdate !== "agent_message_chunk" || update.update.content.type !== "text") return "";
  return update.update.content.text;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function launchCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"],
): ChildProcess {
  const child = spawn(process.execPath, ["--import", tsxLoader, cliEntry, ...args], { env, stdio });
  children.push(child);
  return child;
}

function childStream(child: ChildProcess): Stream {
  if (child.stdin == null || child.stdout == null) throw new Error("ACP adapter did not expose stdio");
  return ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForEvents(path: string, count: number) {
  let events = await readRedskilledEvents(path);
  await waitFor(async () => {
    events = await readRedskilledEvents(path);
    return events.filter((event) => event.kind === "worker-birth" || event.kind === "worker-death").length >= count;
  }, `${count} Worker lifecycle events`);
  return events.filter((event) => event.kind === "worker-birth" || event.kind === "worker-death");
}

async function waitForEvent(path: string, kind: "worker-birth" | "worker-death", workerId?: string) {
  let found: Awaited<ReturnType<typeof readRedskilledEvents>>[number] | undefined;
  await waitFor(async () => {
    found = (await readRedskilledEvents(path)).find((event) =>
      event.kind === kind && (workerId == null || event.worker_id === workerId));
    return found != null;
  }, `${kind} event`);
  return found!;
}
