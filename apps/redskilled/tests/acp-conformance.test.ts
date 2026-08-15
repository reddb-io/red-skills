import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acpV1 from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { afterEach, describe, expect, it } from "vitest";
import { ACP_V2_DRAFT_REVISION, REDSKILLS_WIRE_MAJOR } from "../src/acp-control-plane.js";
import { readRedskilledHostState } from "../src/client.js";
import { socketAnswers } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");
const children: ChildProcess[] = [];
const roots: string[] = [];

interface NormalizedUpdate {
  readonly kind: "plan" | "message" | "terminal";
  readonly text?: string;
  readonly stopReason?: string;
}

interface CorpusClient {
  readonly updates: NormalizedUpdate[];
  initialize(): Promise<void>;
  newSession(cwd: string): Promise<string>;
  prompt(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  hostState(): Promise<{ workers: Array<{ worker_id: string }> }>;
  close(): void;
}

interface SupportedAdapter {
  readonly label: string;
  readonly peerVersion: string;
  connect(child: ChildProcess, peerVersion: string, wireMajor: number): CorpusClient;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the maintained ACP adapters", () => {
  it.each([
    { label: "ACP v1 / newer minor component", peerVersion: "1.7.0", connect: connectV1 },
    { label: "ACP v1 / newer patch component", peerVersion: "1.0.9", connect: connectV1 },
    {
      label: `ACP v2 ${ACP_V2_DRAFT_REVISION} / newer minor component`,
      peerVersion: "1.7.0",
      connect: connectV2,
    },
    {
      label: `ACP v2 ${ACP_V2_DRAFT_REVISION} / newer patch component`,
      peerVersion: "1.0.9",
      connect: connectV2,
    },
  ] satisfies SupportedAdapter[])("runs the same-wire-major session corpus through $label", async (adapter) => {
    const runtime = await launchDaemon();
    const stdioAdapter = launchCli(["acp"], runtime.env, ["pipe", "pipe", "pipe"]);
    const client = adapter.connect(stdioAdapter, adapter.peerVersion, REDSKILLS_WIRE_MAJOR);

    await client.initialize();
    const sessionId = await client.newSession(runtime.root);
    await client.prompt(sessionId, "complete the native tracer");

    expect(client.updates.map((entry) => entry.kind)).toContain("plan");
    expect(client.updates.some((entry) =>
      entry.kind === "message" && entry.text?.includes("native Worker completed") === true,
    )).toBe(true);
    expect(client.updates.at(-1)).toMatchObject({ kind: "terminal", stopReason: "end_turn" });

    const firstBirth = await waitForEvent(runtime.paths.eventLanePath, "worker-birth");
    expect(firstBirth.project_label).toBe("redskills/acp");
    expect(firstBirth.pid).toBeGreaterThan(0);
    const liveAfterTerminal = await client.hostState();
    expect(liveAfterTerminal.workers.map((worker) => worker.worker_id)).toContain(firstBirth.worker_id);
    const firstDeath = await waitForEvent(runtime.paths.eventLanePath, "worker-death", firstBirth.worker_id);
    expect(Date.parse(firstDeath.ts)).toBeGreaterThanOrEqual(Date.parse(firstBirth.ts));

    client.updates.length = 0;
    const cancelledPrompt = client.prompt(sessionId, "wait for cancellation");
    await waitFor(
      () => client.updates.some((entry) => entry.kind === "message"),
      "Worker progress before cancellation",
    );
    await client.cancel(sessionId);
    await cancelledPrompt;
    expect(client.updates.at(-1)).toMatchObject({ kind: "terminal", stopReason: "cancelled" });

    const events = await waitForEvents(runtime.paths.eventLanePath, 4);
    const births = events.filter((event) => event.kind === "worker-birth");
    const deaths = events.filter((event) => event.kind === "worker-death");
    expect(births).toHaveLength(2);
    expect(deaths).toHaveLength(2);
    expect(new Set(deaths.map((event) => event.worker_id))).toEqual(new Set(births.map((event) => event.worker_id)));

    client.close();
    stdioAdapter.stdin?.end();
    runtime.daemon.kill("SIGTERM");
  }, 30_000);

  it.each([
    { label: "ACP v1", peerVersion: "2.0.0", connect: connectV1 },
    { label: `ACP v2 ${ACP_V2_DRAFT_REVISION}`, peerVersion: "2.0.0", connect: connectV2 },
  ] satisfies SupportedAdapter[])("refuses a cross-major $label peer before creating workflow state", async (adapter) => {
    const runtime = await launchDaemon();
    const stdioAdapter = launchCli(["acp"], runtime.env, ["pipe", "pipe", "pipe"]);
    const receivedWireMajor = REDSKILLS_WIRE_MAJOR + 1;
    const client = adapter.connect(stdioAdapter, adapter.peerVersion, receivedWireMajor);

    await expect(client.initialize()).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/RedSkills wire major/),
      data: {
        redskills: {
          receivedWireMajor,
          supportedWireMajor: REDSKILLS_WIRE_MAJOR,
        },
      },
    });

    expect(await readRedskilledEvents(runtime.paths.eventLanePath)).toEqual([]);
    const state = await readRedskilledHostState(runtime.paths);
    expect(state.workers).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(state.registrations).toEqual([]);
    expect((await readdir(runtime.root, { recursive: true })).filter((path) =>
      /acp.*session|session.*journal/i.test(path),
    )).toEqual([]);

    client.close();
    stdioAdapter.stdin?.end();
    runtime.daemon.kill("SIGTERM");
  }, 30_000);

  it.each([
    { label: "omitted", revision: undefined },
    { label: "unknown", revision: "schema-v2.0.0-alpha.999" },
  ])("refuses an $label v2 draft revision before creating workflow state", async ({ revision }) => {
    const runtime = await launchDaemon();
    const stdioAdapter = launchCli(["acp"], runtime.env, ["pipe", "pipe", "pipe"]);
    const connection = acpV2.client({ name: "redskilled-v2-negotiation-test" }).connect(childV2Stream(stdioAdapter));

    await expect(connection.agent.request(acpV2.methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "redskilled-test-client", version: "1" },
      capabilities: {},
      ...(revision == null ? {} : { _meta: { redskills: { acpDraftRevision: revision } } }),
    })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/ACP v2 draft revision/),
      data: {
        redskills: {
          receivedRevision: revision ?? "omitted",
          supportedRevision: ACP_V2_DRAFT_REVISION,
        },
      },
    });

    expect(await readRedskilledEvents(runtime.paths.eventLanePath)).toEqual([]);
    const state = await readRedskilledHostState(runtime.paths);
    expect(state.workers).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(state.registrations).toEqual([]);
    expect((await readdir(runtime.root, { recursive: true })).filter((path) =>
      /acp.*session|session.*journal/i.test(path),
    )).toEqual([]);

    connection.close();
    stdioAdapter.stdin?.end();
    runtime.daemon.kill("SIGTERM");
  }, 30_000);

  it("pins the SDK v2 generated schema and types to schema-v2.0.0-alpha.2", async () => {
    const schemaPath = require_.resolve("@agentclientprotocol/sdk/schema/v2/schema.unstable.json");
    const sdkRoot = resolve(dirname(schemaPath), "..", "..");
    const packageJson = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")) as { version?: unknown };
    const generatedTypes = join(sdkRoot, "dist", "v2", "schema", "types.gen.d.ts");

    expect(packageJson.version).toBe("1.3.0");
    expect(ACP_V2_DRAFT_REVISION).toBe("schema-v2.0.0-alpha.2");
    expect({
      schema: await sha256(schemaPath),
      generatedTypes: await sha256(generatedTypes),
    }).toEqual({
      schema: "e1ef10a309878485fc3be76e64334ba638c6da4517ed585987368f7f8012bc03",
      generatedTypes: "a02424517cea030423d5a2c8b5740eb29af20721cffe9f0c2959465a7bc9d823",
    });
  });
});

function connectV1(child: ChildProcess, peerVersion: string, wireMajor: number): CorpusClient {
  const updates: NormalizedUpdate[] = [];
  const app = acpV1.client({ name: "redskilled-acp-v1-conformance" })
    .onNotification(acpV1.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "plan") updates.push({ kind: "plan" });
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") {
        updates.push({ kind: "message", text: params.update.content.text });
      }
    });
  const connection = app.connect(childV1Stream(child));
  return {
    updates,
    async initialize() {
      const response = await connection.agent.request(acpV1.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "redskilled-test-client", version: peerVersion },
        _meta: { redskills: { wireMajor } },
      });
      expect(response.protocolVersion).toBe(1);
      expect(response.agentInfo?.name).toBe("RedSkills");
      expect(response._meta).toMatchObject({ redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } });
    },
    async newSession(cwd) {
      return (await connection.agent.request(acpV1.methods.agent.session.new, { cwd, mcpServers: [] })).sessionId;
    },
    async prompt(sessionId, text) {
      const response = await connection.agent.request(acpV1.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      updates.push({ kind: "terminal", stopReason: response.stopReason });
    },
    async cancel(sessionId) {
      await connection.agent.notify(acpV1.methods.agent.session.cancel, { sessionId });
    },
    hostState() {
      return connection.agent.request("_redskills/host_state", {});
    },
    close() {
      connection.close();
    },
  };
}

function connectV2(child: ChildProcess, peerVersion: string, wireMajor: number): CorpusClient {
  const updates: NormalizedUpdate[] = [];
  const app = acpV2.client({ name: "redskilled-acp-v2-conformance" })
    .onNotification(acpV2.methods.client.session.update, ({ params }) => {
      const update = params.update;
      if (update.sessionUpdate === "plan_update") updates.push({ kind: "plan" });
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content != null &&
        typeof update.content === "object" &&
        "type" in update.content &&
        update.content.type === "text" &&
        "text" in update.content &&
        typeof update.content.text === "string"
      ) {
        updates.push({ kind: "message", text: update.content.text });
      }
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        updates.push({
          kind: "terminal",
          ...(typeof update.stopReason === "string" ? { stopReason: update.stopReason } : {}),
        });
      }
    });
  const connection = app.connect(childV2Stream(child));
  return {
    updates,
    async initialize() {
      const response = await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "redskilled-test-client", version: peerVersion },
        capabilities: {},
        _meta: { redskills: { wireMajor, acpDraftRevision: ACP_V2_DRAFT_REVISION } },
      });
      expect(response.protocolVersion).toBe(2);
      expect(response.info.name).toBe("RedSkills");
      expect(response._meta).toMatchObject({
        redskills: {
          wireMajor: REDSKILLS_WIRE_MAJOR,
          acpDraftRevision: ACP_V2_DRAFT_REVISION,
        },
      });
    },
    async newSession(cwd) {
      return (await connection.agent.request(acpV2.methods.agent.session.new, { cwd, mcpServers: [] })).sessionId;
    },
    async prompt(sessionId, text) {
      const terminalCount = updates.filter((entry) => entry.kind === "terminal").length;
      await connection.agent.request(acpV2.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      await waitFor(
        () => updates.filter((entry) => entry.kind === "terminal").length > terminalCount,
        "ACP v2 terminal state",
      );
    },
    async cancel(sessionId) {
      await connection.agent.notify(acpV2.methods.agent.session.cancel, { sessionId });
    },
    hostState() {
      return connection.agent.request("_redskills/host_state", {});
    },
    close() {
      connection.close();
    },
  };
}

async function launchDaemon(): Promise<{
  root: string;
  env: NodeJS.ProcessEnv;
  paths: RedskilledPaths;
  daemon: ChildProcess;
}> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-acp-conformance-"));
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
  return { root, env, paths, daemon };
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

function childV1Stream(child: ChildProcess): acpV1.Stream {
  if (child.stdin == null || child.stdout == null) throw new Error("ACP adapter did not expose stdio");
  return acpV1.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}

function childV2Stream(child: ChildProcess): acpV2.Stream {
  if (child.stdin == null || child.stdout == null) throw new Error("ACP adapter did not expose stdio");
  return acpV2.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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
