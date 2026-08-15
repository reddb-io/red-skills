import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
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
    expect(firstBirth.project_label).toBe("redskills/acp");
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
});

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
