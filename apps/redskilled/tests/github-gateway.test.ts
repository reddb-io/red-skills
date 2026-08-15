import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, RequestError, type ClientConnection } from "@agentclientprotocol/sdk";
import { GithubBackpressureError } from "@reddb-io/github";
import { describe, expect, it } from "vitest";
import {
  REDSKILLED_GITHUB_READ_METHOD,
  REDSKILLED_GITHUB_WRITE_METHOD,
  RedskilledGithubAuthorityError,
  createRedskilledGithubGateway,
  createRedskilledGithubUpstream,
  type RedskilledGithubReadAnswer,
  type RedskilledGithubProjectAuthority,
  type RedskilledGithubUpstream,
  type RedskilledGithubWriteUpstream,
} from "../src/github-gateway.js";
import { bindAcpProjectGithubRead } from "../src/acp-github.js";
import { decode } from "@reddb-io/toon";
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
  it("durably serializes writes and resumes a transient failure without duplicate publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-github-outbox-"));
    const outboxPath = join(root, "github-outbox.toon");
    const calls: string[] = [];
    let failFirst = true;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const upstream: RedskilledGithubWriteUpstream = async ({ idempotencyKey, write }) => {
      calls.push(`${idempotencyKey}:${write.kind}`);
      if (idempotencyKey === "push-main") await firstHeld;
      if (failFirst) {
        failFirst = false;
        throw new Error("temporary gateway failure");
      }
      return { publication_id: `published:${idempotencyKey}` };
    };

    try {
      const firstGateway = createRedskilledGithubGateway({
        upstream: async () => ({ value: {}, budget: null }),
        writeUpstream: upstream,
        outboxPath,
        clock: () => "2026-08-15T21:00:00.000Z",
      });
      const first = firstGateway.forProject(PROJECT, { secret: "daemon-only" });
      const push = first.write({
        idempotency_key: "push-main",
        write: { kind: "repository-push", ref: "refs/heads/worker-3887", sha: "a".repeat(40) },
      });
      const issue = first.write({
        idempotency_key: "publish-issue",
        write: { kind: "issue-publication", issue: 3887, body: "publication evidence" },
      });
      await Promise.resolve();
      expect(calls).toEqual(["push-main:repository-push"]);
      releaseFirst();
      await expect(push).rejects.toThrow("temporary gateway failure");
      await expect(issue).resolves.toMatchObject({
        idempotency_key: "publish-issue",
        state: "published",
        value: { publication_id: "published:publish-issue" },
      });

      const persisted = decode((await readFile(outboxPath, "utf8")).trim()) as {
        entries: Array<{ idempotency_key: string; state: string; credential?: unknown }>;
      };
      expect(persisted.entries).toMatchObject([
        { idempotency_key: "push-main", state: "pending" },
        { idempotency_key: "publish-issue", state: "published" },
      ]);
      expect(JSON.stringify(persisted)).not.toContain("daemon-only");

      const recoveredCalls: string[] = [];
      const recovered = createRedskilledGithubGateway({
        upstream: async () => ({ value: {}, budget: null }),
        writeUpstream: async ({ idempotencyKey }) => {
          recoveredCalls.push(idempotencyKey);
          return { publication_id: `published:${idempotencyKey}` };
        },
        outboxPath,
        clock: () => "2026-08-15T21:01:00.000Z",
      }).forProject(PROJECT, { secret: "rotated-daemon-only" });

      await expect(recovered.resumeWrites()).resolves.toMatchObject([
        { idempotency_key: "push-main", state: "published" },
      ]);
      await expect(recovered.write({
        idempotency_key: "push-main",
        write: { kind: "repository-push", ref: "refs/heads/worker-3887", sha: "a".repeat(40) },
      })).resolves.toMatchObject({
        idempotency_key: "push-main",
        state: "published",
        value: { publication_id: "published:push-main" },
      });
      expect(recoveredCalls).toEqual(["push-main"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates secondary throttling by credential profile and coalesces one recovery refresh", async () => {
    let engineeringThrottled = true;
    let engineeringCalls = 0;
    let releaseRecovery!: () => void;
    const recoveryHeld = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const upstream = createRedskilledGithubUpstream({
      clock: () => "2026-08-15T21:00:00.000Z",
      fetchImpl: async (_url, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer engineering-secret") {
          engineeringCalls += 1;
          if (engineeringThrottled) {
            return new Response("secondary rate limit", {
              status: 403,
              headers: { "retry-after": "60", "x-ratelimit-remaining": "4999" },
            });
          }
          await recoveryHeld;
        }
        return new Response(JSON.stringify({ state: "open" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "4900" },
        });
      },
    });
    const gateway = createRedskilledGithubGateway({
      upstream,
      clock: () => "2026-08-15T21:00:00.000Z",
    });
    const engineering = gateway.forProject(PROJECT, { secret: "engineering-secret" });
    const release = gateway.forProject(
      { ...PROJECT, credentialProfile: "release" },
      { secret: "release-secret" },
    );

    const throttled = await engineering.read({ kind: "rest", path: "issues/17" })
      .then(() => null, (error: unknown) => error);
    expect(throttled).toBeInstanceOf(GithubBackpressureError);
    expect(throttled).toMatchObject({
      fact: { kind: "secondary-throttled", retry_at: "2026-08-15T21:01:00.000Z" },
    });
    await expect(release.read({ kind: "rest", path: "issues/17" })).resolves.toMatchObject({
      credential_profile: "release",
      source: "upstream",
    });

    engineeringThrottled = false;
    const first = engineering.read({ kind: "rest", path: "issues/17" });
    const second = engineering.read({ kind: "rest", path: "issues/17" });
    await Promise.resolve();
    expect(engineeringCalls).toBe(2);
    releaseRecovery();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(engineeringCalls).toBe(2);
  });

  it("projects typed GitHub backpressure through ACP without birthing a Worker", async () => {
    const retryAt = "2026-08-15T22:00:00.000Z";
    const fact = {
      kind: "primary-rest-exhausted" as const,
      pool: "rest" as const,
      retry_at: retryAt,
      evidence: "balance" as const,
      message: `REST primary quota is exhausted; retry after ${retryAt}`,
    };
    const read = bindAcpProjectGithubRead({
      credentialForProject: () => ({ profile: "engineering", credential: { secret: "fixture" } }),
      gateway: {
        forProject: () => ({
          read: async () => { throw new GithubBackpressureError(fact); },
          write: async () => { throw new Error("unused write"); },
          resumeWrites: async () => [],
        }),
      },
    }, () => ({
      projectId: PROJECT.projectId,
      projectLabel: PROJECT.projectLabel,
      checkoutRoot: "/client-checkouts/widgets",
      workspacePath: PROJECT.workspacePath,
    }));

    const error = await read({ params: { read: { kind: "rest", path: "issues/17" } } })
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({
      code: -32001,
      data: {
        version: 1,
        kind: "github-backpressure",
        project_id: PROJECT.projectId,
        credential_profile: "engineering",
        retry_at: retryAt,
        fact: { kind: "primary-rest-exhausted" },
      },
    });
  });

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

  it("returns an eligible dated cache answer before quota backpressure", async () => {
    let now = "2026-08-15T18:00:00.000Z";
    let throttled = false;
    const retryAt = "2026-08-15T19:00:00.000Z";
    const gateway = createRedskilledGithubGateway({
      freshMs: 1,
      clock: () => now,
      upstream: async () => {
        if (throttled) {
          throw new GithubBackpressureError({
            kind: "primary-rest-exhausted",
            pool: "rest",
            retry_at: retryAt,
            evidence: "balance",
            message: `REST primary quota is exhausted; retry after ${retryAt}`,
          });
        }
        return { value: { state: "open" }, budget: { pool: "rest", remaining: 1, reset_at: retryAt } };
      },
    });
    const reader = gateway.forProject(PROJECT, { secret: "fixture" });
    await reader.read({ kind: "rest", path: "issues/17" });
    throttled = true;
    now = "2026-08-15T18:00:01.000Z";

    await expect(reader.read({ kind: "rest", path: "issues/17" })).resolves.toMatchObject({
      source: "cache",
      cache: { outcome: "stale", age_ms: 1_000 },
      backpressure: { kind: "primary-rest-exhausted", retry_at: retryAt },
      retry_at: retryAt,
      value: { state: "open" },
    });
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
      outboxPath: join(root, "github-outbox.toon"),
      writeUpstream: async ({ idempotencyKey, write }) => ({ idempotencyKey, kind: write.kind }),
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

      await expect(connections[1]!.agent.request(REDSKILLED_GITHUB_WRITE_METHOD, {
        idempotency_key: "worker-pr-3887",
        write: {
          kind: "pull-request",
          head: "worker/3887",
          base: "main",
          title: "Publish Worker result",
          body: "Refs #3887",
        },
      })).resolves.toMatchObject({
        project_id: "github:101",
        credential_profile: "engineering",
        idempotency_key: "worker-pr-3887",
        state: "published",
        value: { kind: "pull-request" },
      });
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
