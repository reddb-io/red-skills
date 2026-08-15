import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type ClientConnection } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  REDSKILLED_GITHUB_READ_METHOD,
  RedskilledGithubAuthorityError,
  createRedskilledGithubGateway,
  type RedskilledGithubReadAnswer,
  type RedskilledGithubProjectAuthority,
  type RedskilledGithubUpstream,
} from "../src/github-gateway.js";
import { startRedskillsAcpControlPlane } from "../src/acp-control-plane.js";
import { socketStream } from "../src/acp-socket.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const PROJECT: RedskilledGithubProjectAuthority = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  workspacePath: "/project-workspaces/widgets",
  credentialProfile: "engineering",
};

describe("the Project-scoped redskilled GitHub gateway", () => {
  it.each([
    { kind: "rest" as const, path: "issues/17" },
    { kind: "graphql" as const, selection: "issue(number: 17) { id state }" },
    { kind: "repository-fetch" as const, ref: "refs/heads/main" },
  ])("coalesces concurrent equivalent $kind reads into one upstream request", async (request) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const seen: Parameters<RedskilledGithubUpstream>[0][] = [];
    const gateway = createRedskilledGithubGateway({
      clock: () => "2026-08-15T18:00:00.000Z",
      upstream: async (input) => {
        seen.push(input);
        await held;
        return {
          value: { state: "OPEN" },
          budget: { pool: input.read.kind === "graphql" ? "graphql" : "rest", remaining: 4_900, reset_at: null },
        };
      },
    });
    const reader = gateway.forProject(PROJECT, { secret: "fixture credential" });

    const first = reader.read(request);
    const second = reader.read({ ...request });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    release();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { source: "upstream", cache: { age_ms: 0 }, credential_profile: "engineering" },
      { source: "upstream", cache: { age_ms: 0 }, credential_profile: "engineering" },
    ]);
    expect(seen[0]).toMatchObject({
      project: PROJECT,
      credential: { secret: "fixture credential" },
      read: request,
    });
  });

  it("returns age and budget facts while isolating cache entries by Project and credential profile", async () => {
    let now = "2026-08-15T18:00:00.000Z";
    let calls = 0;
    const gateway = createRedskilledGithubGateway({
      clock: () => now,
      upstream: async () => ({
        value: { sequence: ++calls },
        budget: { pool: "rest", remaining: 4_800, reset_at: "2026-08-15T19:00:00.000Z" },
      }),
    });
    const first = gateway.forProject(PROJECT, { secret: "first credential" });
    expect(await first.read({ kind: "rest", path: "issues/17" })).toMatchObject({
      source: "upstream",
      project_id: "github:101",
      credential_profile: "engineering",
      cache: { age_ms: 0, fetched_at: now, outcome: "fresh" },
      budget: { pool: "rest", remaining: 4_800 },
      value: { sequence: 1 },
    });

    now = "2026-08-15T18:00:07.000Z";
    expect(await first.read({ kind: "rest", path: "/issues/17" })).toMatchObject({
      source: "cache",
      credential_profile: "engineering",
      cache: { age_ms: 7_000, outcome: "fresh" },
      value: { sequence: 1 },
    });

    const otherProfile = gateway.forProject(
      { ...PROJECT, credentialProfile: "release" },
      { secret: "second credential" },
    );
    const otherProject = gateway.forProject(
      { ...PROJECT, projectId: "github:202", projectLabel: "acme/other" },
      { secret: "first credential" },
    );
    expect((await otherProfile.read({ kind: "rest", path: "issues/17" })).value).toEqual({ sequence: 2 });
    expect((await otherProject.read({ kind: "rest", path: "issues/17" })).value).toEqual({ sequence: 3 });
    expect(calls).toBe(3);

    const publicAnswer = JSON.stringify(await first.read({ kind: "rest", path: "issues/17" }));
    expect(publicAnswer).not.toContain("first credential");
    expect(publicAnswer).not.toContain("second credential");
  });

  it("cannot address another Project or turn Project authority into host administration", async () => {
    const gateway = createRedskilledGithubGateway({
      upstream: async () => ({ value: {}, budget: null }),
    });
    const reader = gateway.forProject(PROJECT, { secret: "fixture credential" });

    await expect(reader.read({ kind: "rest", path: "repos/acme/other/issues/1" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "rest", path: "/user" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "graphql", selection: "repository(owner: \"other\", name: \"repo\") { id }" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "graphql", selection: "viewer { login }" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "repository-fetch", ref: "--upload-pack=admin" }))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
    await expect(reader.read({ kind: "rest", path: "issues/1", project_id: "github:202" } as never))
      .rejects.toBeInstanceOf(RedskilledGithubAuthorityError);
  });

  it("shares one gateway across Project ACP clients without widening their authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-github-gateway-"));
    const checkout = join(root, "checkout");
    execFileSync("git", ["init", checkout], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
      cwd: checkout,
      stdio: "ignore",
    });
    const identityServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 101, full_name: "acme/widgets" }));
    });
    identityServer.listen(0, "127.0.0.1");
    await once(identityServer, "listening");
    const address = identityServer.address();
    if (address == null || typeof address === "string") throw new Error("identity fixture did not bind TCP");

    const previousApi = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = `http://127.0.0.1:${address.port}`;
    let upstreamCalls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gateway = createRedskilledGithubGateway({
      upstream: async () => {
        upstreamCalls += 1;
        markStarted();
        await held;
        return { value: { state: "OPEN" }, budget: { pool: "rest", remaining: 4_700, reset_at: null } };
      },
    });
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    let authorizedReads = 0;
    let markBothAuthorized!: () => void;
    const bothAuthorized = new Promise<void>((resolve) => { markBothAuthorized = resolve; });
    const control = await startRedskillsAcpControlPlane({
      paths,
      startWorker: () => { throw new Error("the GitHub gateway must not birth a Worker"); },
      hostState: () => ({ workers: [] }) as never,
      githubGateway: {
        gateway,
        credentialForProject: () => {
          authorizedReads += 1;
          if (authorizedReads === 2) markBothAuthorized();
          return { profile: "engineering", credential: { secret: "fixture credential" } };
        },
      },
    });
    const connections: ClientConnection[] = [];
    try {
      for (const name of ["editor", "worker"]) {
        const socket = connect(control.socketPath);
        await once(socket, "connect");
        const connection = client({ name }).connect(socketStream(socket));
        connections.push(connection);
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name, version: "1" },
        });
        await connection.agent.request(methods.agent.session.new, { cwd: checkout, mcpServers: [] });
      }

      const first = connections[0]!.agent.request<RedskilledGithubReadAnswer>(
        REDSKILLED_GITHUB_READ_METHOD,
        { read: { kind: "rest", path: "issues/17" } },
      );
      const second = connections[1]!.agent.request<RedskilledGithubReadAnswer>(
        REDSKILLED_GITHUB_READ_METHOD,
        { read: { kind: "rest", path: "/issues/17" } },
      );
      await Promise.all([started, bothAuthorized]);
      expect(upstreamCalls).toBe(1);
      release();
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { project_id: "github:101", credential_profile: "engineering", source: "upstream" },
        { project_id: "github:101", credential_profile: "engineering", source: "upstream" },
      ]);

      await expect(connections[0]!.agent.request(REDSKILLED_GITHUB_READ_METHOD, {
        read: { kind: "rest", path: "issues/17" },
        project_id: "github:202",
      })).rejects.toThrow();
      await expect(connections[0]!.agent.request(REDSKILLED_GITHUB_READ_METHOD, {
        read: { kind: "rest", path: "/user" },
      })).rejects.toThrow();
    } finally {
      for (const connection of connections) connection.close();
      await control.close();
      await new Promise<void>((resolve) => identityServer.close(() => resolve()));
      if (previousApi == null) delete process.env.GITHUB_API_URL;
      else process.env.GITHUB_API_URL = previousApi;
      await rm(root, { recursive: true, force: true });
    }
  });
});
