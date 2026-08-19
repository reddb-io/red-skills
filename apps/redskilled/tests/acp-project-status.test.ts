import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type ClientConnection } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { RedskillsProjectStatusSnapshot } from "../src/acp-client.js";
import { startRedskillsAcpControlPlane } from "../src/acp-control-plane.js";
import { socketStream } from "@reddb-io/protocol-acp";
import { resolveRedskilledPaths } from "../src/paths.js";
import { resolveAcpProjectIdentity } from "../src/project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Project-scoped ACP status context", () => {
  it("carries daemon-owned queue, Worker, adapter-health, and stale/unknown facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-project-status-"));
    roots.push(root);
    const identity = await resolveAcpProjectIdentity(root, { env: {} });
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    let observed = hostState(identity.projectLabel, true);
    const control = await startRedskillsAcpControlPlane({
      paths,
      clock: () => "2026-08-17T15:00:00.000Z",
      startWorker: () => { throw new Error("status must not birth a Worker"); },
      hostState: () => observed as never,
    });
    let connection: ClientConnection | undefined;
    try {
      const connected = await connectProject(control.socketPath, root);
      connection = connected.connection;
      const status = await connection.agent.request<RedskillsProjectStatusSnapshot>(
        "_redskills/project_status",
        {},
      );

      expect(status.context).toEqual({
        version: 1,
        observed_at: "2026-08-17T15:00:00.000Z",
        queue: {
          posture: "at-target",
          depth: 4,
          target: 2,
          live: 1,
          wanted: 0,
          observed_at: "2026-08-17T14:59:00.000Z",
          age_ms: 60_000,
          freshness: "stale",
          detail: "the Project is holding its declared target",
        },
        workers: {
          total: 1,
          freshness: "fresh",
          observed_at: "2026-08-17T15:00:00.000Z",
          items: [{
            worker_id: "worker-project",
            state: "running",
            started_at: "2026-08-17T14:55:00.000Z",
            isolated: true,
            warnings: [],
            base_commits_ahead: 3,
          }],
        },
        adapter_health: {
          status: "degraded",
          checked_at: "2026-08-17T14:59:58.000Z",
          last_success_at: "2026-08-17T14:59:50.000Z",
          last_failure_at: "2026-08-17T14:59:58.000Z",
          detail: "the request lane missed its threshold",
        },
      });

      const generic = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: connected.sessionId,
        prompt: [{ type: "text", text: "/status" }],
      });
      expect((generic._meta as { redskills?: { projectControl?: unknown } } | undefined)
        ?.redskills?.projectControl).toEqual(status);

      observed = hostState(identity.projectLabel, false);
      const unknown = await connection.agent.request<RedskillsProjectStatusSnapshot>(
        "_redskills/project_status",
        {},
      );
      expect(unknown.context.queue).toMatchObject({
        posture: "unknown",
        depth: null,
        wanted: null,
        observed_at: null,
        age_ms: null,
        freshness: "unknown",
      });
      expect(unknown.context.adapter_health).toEqual({
        status: "unknown",
        checked_at: null,
        last_success_at: null,
        last_failure_at: null,
        detail: "the daemon has not published request-lane health",
      });
      expect(unknown.context.workers.items[0]?.base_commits_ahead).toBeNull();
      expect(JSON.stringify(unknown)).not.toContain("worker-other-project");
    } finally {
      connection?.close();
      await control.close();
    }
  });
});

function hostState(projectLabel: string, measured: boolean) {
  const projectWorker = {
    worker_id: "worker-project",
    project_label: projectLabel,
    pid: 101,
    started_at: "2026-08-17T14:55:00.000Z",
    workspace_path: "[DAEMON_WORKSPACE]",
    isolated: true,
    warnings: [],
    ...(measured ? { base_commits_ahead: 3 } : {}),
  };
  return {
    workers: [
      projectWorker,
      { ...projectWorker, worker_id: "worker-other-project", project_label: "other/project" },
    ],
    registrations: [{
      project_label: projectLabel,
      target: 2,
      ...(measured ? {
        last_poll: {
          at: "2026-08-17T14:59:00.000Z",
          outcome: "counted",
          depth: 4,
          request_count: 1,
          detail: "four eligible Tickets",
        },
      } : {}),
    }],
    ...(measured ? {
      demand: {
        at: "2026-08-17T14:59:01.000Z",
        projects: [{
          project_label: projectLabel,
          outcome: "at-target",
          queue_depth: 4,
          target: 2,
          live: 1,
          wanted: 0,
          detail: "the Project is holding its declared target",
        }],
      },
      request_health: {
        status: "degraded",
        consecutive_misses: 3,
        miss_threshold: 3,
        last_probe_at: "2026-08-17T14:59:58.000Z",
        last_success_at: "2026-08-17T14:59:50.000Z",
        last_failure_at: "2026-08-17T14:59:58.000Z",
        detail: "the request lane missed its threshold",
      },
    } : {}),
  };
}

async function connectProject(
  socketPath: string,
  cwd: string,
): Promise<{ readonly connection: ClientConnection; readonly sessionId: string }> {
  const socket = connect(socketPath);
  await once(socket, "connect");
  const connection = client({ name: "Project status contract" }).connect(socketStream(socket));
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "Project status contract", version: "1" },
  });
  const session = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
  return { connection, sessionId: session.sessionId };
}
