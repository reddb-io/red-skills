import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type ClientConnection } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  REDSKILLED_GITHUB_CUSTODY_HANDOFF_METHOD,
  createRedskilledGithubGateway,
  type RedskilledGithubCustodyStatus,
} from "../src/github-gateway.js";
import { startRedskillsAcpControlPlane } from "../src/acp-control-plane.js";
import { socketStream } from "@reddb-io/protocol-acp";
import { resolveRedskilledPaths } from "../src/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("redskilled GitHub merge custody", () => {
  it("finishes a clean pull request after every handing-off client disconnects", async () => {
    const root = await fixtureRoot("redskilled-github-custody-");
    const checkout = join(root, "checkout");
    execFileSync("git", ["init", checkout], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
      cwd: checkout,
      stdio: "ignore",
    });
    const identity = await identityFixture();
    const previousApi = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = identity.origin;

    let nativeIntent = false;
    let merged = false;
    let armCalls = 0;
    let finish!: () => void;
    const terminal = new Promise<void>((resolve) => { finish = resolve; });
    const gateway = createRedskilledGithubGateway({
      upstream: async () => ({ value: {}, budget: null }),
      outboxPath: join(root, "github-outbox.toon"),
      custodyPath: join(root, "github-custody.toon"),
      custodyTickMs: 1,
      writeUpstream: async ({ write }) => write.kind === "pull-request" ? { number: 73 } : {},
      custodyUpstream: {
        async observe() {
          if (nativeIntent) {
            merged = true;
            finish();
          }
          return merged
            ? { forge_state: "merged", native_intent: false }
            : { forge_state: "open-clean", native_intent: nativeIntent };
        },
        async arm() {
          armCalls += 1;
          nativeIntent = true;
          return { forge_state: "open-pending", native_intent: true };
        },
      },
    });
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const control = await startRedskillsAcpControlPlane({
      paths,
      startWorker: () => { throw new Error("merge custody must not birth a client-owned Worker"); },
      hostState: () => ({ workers: [] }) as never,
      githubGateway: {
        gateway,
        credentialForProject: () => ({ profile: "engineering", credential: { secret: "fixture" } }),
      },
    });
    let handingOff: ClientConnection | undefined;
    let observer: ClientConnection | undefined;
    try {
      handingOff = await connectProjectClient(control.socketPath, checkout, "worker");
      await expect(handingOff.agent.request("_redskills/github_write", {
        idempotency_key: "worker-pr-3653",
        write: {
          kind: "pull-request",
          head: "worker/3653",
          base: "main",
          title: "Publish Worker result",
          body: "Closes #3653",
        },
      })).resolves.toMatchObject({ state: "published", value: { number: 73 } });
      await expect(handingOff.agent.request(REDSKILLED_GITHUB_CUSTODY_HANDOFF_METHOD, {
        pull_request: 73,
        owner_ticket: 3653,
        branch: "worker/3653",
        base: "main",
      })).resolves.toMatchObject({ pull_request: 73, state: "active" });

      handingOff.close();
      handingOff = undefined;
      await terminal;

      observer = await connectProjectClient(control.socketPath, checkout, "observer");
      const status = await observer.agent.request<{
        merge_custody: RedskilledGithubCustodyStatus;
      }>("_redskills/project_status", {});
      expect(status.merge_custody.records).toEqual([
        expect.objectContaining({
          pull_request: 73,
          last_tick_at: expect.any(String),
          last_forge_state: "merged",
          next_action: "none",
          terminal_outcome: "merged",
        }),
      ]);
      expect(armCalls).toBe(1);
    } finally {
      handingOff?.close();
      observer?.close();
      await control.close();
      gateway.close();
      await identity.close();
      if (previousApi == null) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = previousApi;
    }
  });

  it("deduplicates recovered publication custody and exposes a bounded inert fault", async () => {
    const root = await fixtureRoot("redskilled-github-custody-recovery-");
    let now = "2026-08-15T20:00:00.000Z";
    let releases = 0;
    const gateway = createRedskilledGithubGateway({
      upstream: async () => ({ value: {}, budget: null }),
      outboxPath: join(root, "github-outbox.toon"),
      custodyPath: join(root, "github-custody.toon"),
      custodyTickMs: 60_000,
      custodyInertMs: 1_000,
      clock: () => now,
      writeUpstream: async () => ({ number: 73 }),
      custodyUpstream: {
        async observe() {
          releases += 1;
          return { forge_state: "open-pending", native_intent: true };
        },
        async arm() {
          throw new Error("an already armed pull request must not be armed twice");
        },
      },
    });
    const project = gateway.forProject({
      projectId: "github:101",
      projectLabel: "acme/widgets",
      workspacePath: join(root, "workspace"),
      credentialProfile: "engineering",
    }, { secret: "fixture" });
    const request = {
      pull_request: 73,
      owner_ticket: 3653,
      branch: "worker/3653",
      base: "main",
    } as const;

    await Promise.all([project.handoffMergeCustody(request), project.handoffMergeCustody(request)]);
    await project.resumeWrites();
    expect((await project.mergeCustodyStatus()).records).toHaveLength(1);

    now = "2026-08-15T20:00:02.000Z";
    expect((await project.mergeCustodyStatus()).records[0]).toMatchObject({
      pull_request: 73,
      next_action: "repair-custodian",
      fault: { kind: "inert-custodian", threshold_ms: 1_000 },
    });
    expect(releases).toBeLessThanOrEqual(1);
    gateway.close();
  });

  it("finds a never-ticked obligation within one declared tick and gives ACP a repair call", async () => {
    const root = await fixtureRoot("redskilled-github-custody-never-ticked-");
    let now = "2026-08-15T20:00:00.000Z";
    const gateway = createRedskilledGithubGateway({
      upstream: async () => ({ value: {}, budget: null }),
      outboxPath: join(root, "github-outbox.toon"),
      custodyPath: join(root, "github-custody.toon"),
      custodyTickMs: 1_000,
      custodyInertMs: 60_000,
      clock: () => now,
      writeUpstream: async () => ({ number: 73 }),
      custodyUpstream: {
        async observe() {
          throw new Error("the closed fixture must never tick");
        },
        async arm() {
          throw new Error("the closed fixture must never tick");
        },
      },
    });
    const project = gateway.forProject({
      projectId: "github:101",
      projectLabel: "acme/widgets",
      workspacePath: join(root, "workspace"),
      credentialProfile: "engineering",
    }, { secret: "fixture" });
    const handoff = {
      pull_request: 73,
      owner_ticket: 3659,
      branch: "worker/3659",
      base: "main",
    } as const;

    await project.handoffMergeCustody(handoff);
    gateway.close();
    now = "2026-08-15T20:00:01.001Z";

    expect((await project.mergeCustodyStatus()).records[0]).toMatchObject({
      pull_request: 73,
      last_tick_at: null,
      next_action: "repair-custodian",
      fault: {
        kind: "inert-custodian",
        threshold_ms: 1_000,
        repair: {
          method: "_redskills/github_custody_handoff",
          params: handoff,
        },
      },
    });
  });
});

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function identityFixture(): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 101, full_name: "acme/widgets" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("identity fixture did not bind TCP");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connectProjectClient(socketPath: string, checkout: string, name: string): Promise<ClientConnection> {
  const socket = connect(socketPath);
  await once(socket, "connect");
  const connection = client({ name }).connect(socketStream(socket));
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name, version: "1" },
  });
  await connection.agent.request(methods.agent.session.new, { cwd: checkout, mcpServers: [] });
  return connection;
}
