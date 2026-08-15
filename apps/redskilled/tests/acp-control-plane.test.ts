import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { socketAnswers } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { resolveRedskilledPaths } from "../src/paths.js";

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

describe("the public RedSkills ACP v1 control plane", () => {
  it("routes updates, terminal results, and cancellation through daemon-admitted native Workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-control-plane-"));
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
    const completed = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "complete the native tracer" }],
    });
    expect(completed.stopReason).toBe("end_turn");
    expect(updates.map((entry) => entry.update.sessionUpdate)).toContain("plan");
    expect(updates.some((entry) =>
      entry.update.sessionUpdate === "agent_message_chunk" &&
      entry.update.content.type === "text" &&
      entry.update.content.text.includes("native Worker completed"),
    )).toBe(true);

    const firstBirth = await waitForEvent(paths.eventLanePath, "worker-birth");
    expect(firstBirth.project_label).toBe(project.projectId);
    expect(firstBirth.workspace_path).toBe(project.workspacePath);
    expect(firstBirth.pid).toBeGreaterThan(0);
    const liveAfterTerminal = await connection.agent.request<{ workers: Array<{ worker_id: string }> }>(
      "_redskills/host_state",
      {},
    );
    expect(liveAfterTerminal.workers.map((worker) => worker.worker_id)).toContain(firstBirth.worker_id);
    const firstDeath = await waitForEvent(paths.eventLanePath, "worker-death", firstBirth.worker_id);
    expect(Date.parse(firstDeath.ts)).toBeGreaterThanOrEqual(Date.parse(firstBirth.ts));

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

    connection.close();
    adapter.stdin?.end();
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
