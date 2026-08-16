import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  client,
  methods,
  ndJsonStream,
  type Stream,
} from "@agentclientprotocol/sdk";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { acpSessionJournalPath } from "../src/acp-session-journal.js";
import { startRedskillsAcpControlPlane } from "../src/acp-control-plane.js";
import {
  resolveAcpWorkerEndpoint,
  resolveRedskilledPaths,
} from "../src/paths.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "../src/worker-launch.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require_.resolve("tsx")).href;
const childAgentFixture = resolve(__dirname, "fixtures", "bin", "redcode");
const stdioAdapterProgram = `
  import { runRedskillsAcpAdapter } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "..", "src", "acp-control-plane.ts")).href)};
  import { resolveRedskilledPaths } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "..", "src", "paths.ts")).href)};
  process.exitCode = await runRedskillsAcpAdapter(resolveRedskilledPaths());
`;
const workerProgram = `
  import { runNativeAcpWorker } from ${JSON.stringify(pathToFileURL(resolve(__dirname, "..", "src", "acp-native-worker.ts")).href)};
  const endpoint = process.env.REDSKILLED_TEST_WORKER_ENDPOINT;
  if (endpoint == null || endpoint === "") throw new Error("missing test Worker endpoint");
  process.exitCode = await runNativeAcpWorker(endpoint, {
    agent: "redcode",
    transport: "stdio",
    command: process.execPath,
    args: [${JSON.stringify(childAgentFixture)}, "acp"],
  });
`;
const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the host-native local ACP authority transport", () => {
  it("reconnects stdio projections to one public endpoint and distinct daemon-assigned Worker endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-local-transport-"));
    roots.push(root);
    const env = {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_MACHINE_DIR: root,
      REDSKILLED_SESSION: `test:${root}`,
      REDSKILLED_ACP_WORKER_IDLE_MS: "100",
    };
    const paths = resolveRedskilledPaths({ env, homeDir: root });
    const assignedWorkerEndpoints: string[] = [];
    let workerSequence = 0;
    const controlPlane = await startRedskillsAcpControlPlane({
      paths,
      hostState: () => ({ workers: [] }) as never,
      startWorker: (spec) => launchTestWorker(spec, env, assignedWorkerEndpoints, ++workerSequence),
    });

    try {
      expect(controlPlane.socketPath).toBe(paths.acpSocketPath);
      expectLocalEndpoint(paths.acpSocketPath, join(paths.runtimeDir, "redskilled-acp.sock"));
      expectLocalEndpoint(
        resolveAcpWorkerEndpoint(paths, "fixture"),
        join(paths.runtimeDir, "acp-workers", "fixture.sock"),
      );

      const first = await openStdioProjection(env, "first");
      await exerciseWorkflow(first.connection, root, "first turn");
      await closeStdioProjection(first);

      const journalPath = acpSessionJournalPath(paths.registrationIntentPath);
      const afterFirstDisconnect = decode(await readFile(journalPath, "utf8")) as unknown as {
        sessions: readonly unknown[];
      };
      expect(afterFirstDisconnect.sessions).toHaveLength(1);

      const second = await openStdioProjection(env, "second");
      await exerciseWorkflow(second.connection, root, "second turn");
      await closeStdioProjection(second);

      expect(assignedWorkerEndpoints).toHaveLength(2);
      expect(new Set(assignedWorkerEndpoints).size).toBe(2);
      for (const endpoint of assignedWorkerEndpoints) {
        if (process.platform === "win32") {
          expectLocalEndpoint(endpoint, "unused-on-Windows");
        } else {
          expect(dirname(endpoint)).toBe(join(paths.runtimeDir, "acp-workers"));
          expect(extname(endpoint)).toBe(".sock");
        }
        expect(endpoint).not.toBe(paths.acpSocketPath);
      }

      const afterSecondDisconnect = decode(await readFile(journalPath, "utf8")) as unknown as {
        sessions: readonly unknown[];
      };
      expect(afterSecondDisconnect.sessions).toHaveLength(2);
    } finally {
      await controlPlane.close();
    }
  }, 30_000);
});

function launchTestWorker(
  spec: RedskilledWorkerSpec,
  env: NodeJS.ProcessEnv,
  assignedEndpoints: string[],
  sequence: number,
): LaunchedWorker {
  const endpoint = flagValue(spec.args ?? [], "--socket");
  assignedEndpoints.push(endpoint);
  const child = spawn(process.execPath, [
    "--import", tsxLoader,
    "--input-type=module",
    "--eval", workerProgram,
  ], {
    cwd: spec.workspace_path,
    env: { ...env, REDSKILLED_TEST_WORKER_ENDPOINT: endpoint },
    stdio: "ignore",
  });
  children.push(child);
  if (child.pid == null) throw new Error("test Worker did not start");
  return {
    worker: {
      worker_id: `transport-worker-${sequence}`,
      project_label: spec.project_label,
      pid: child.pid,
      started_at: new Date().toISOString(),
      workspace_path: spec.workspace_path,
      isolated: false,
      warnings: [],
    },
    child,
  } as unknown as LaunchedWorker;
}

async function openStdioProjection(env: NodeJS.ProcessEnv, label: string): Promise<{
  child: ChildProcess;
  connection: ReturnType<ReturnType<typeof client>["connect"]>;
}> {
  const child = spawn(process.execPath, [
    "--import", tsxLoader,
    "--input-type=module",
    "--eval", stdioAdapterProgram,
  ], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(child);
  const connection = client({ name: `${label}-stdio-projection` }).connect(childStream(child));
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: `${label}-transport-client`, version: "1" },
  });
  return { child, connection };
}

async function exerciseWorkflow(
  connection: ReturnType<ReturnType<typeof client>["connect"]>,
  cwd: string,
  text: string,
): Promise<void> {
  const session = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
  await expect(connection.agent.request(methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text }],
  })).resolves.toMatchObject({ stopReason: "end_turn" });
}

async function closeStdioProjection(projection: {
  child: ChildProcess;
  connection: ReturnType<ReturnType<typeof client>["connect"]>;
}): Promise<void> {
  projection.connection.close();
  projection.child.stdin?.end();
  if (projection.child.exitCode == null && projection.child.signalCode == null) {
    await once(projection.child, "exit");
  }
}

function childStream(child: ChildProcess): Stream {
  if (child.stdin == null || child.stdout == null) throw new Error("ACP adapter did not expose stdio");
  return ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value == null || value === "") throw new Error(`missing ${flag} in Worker argv`);
  return value;
}

function expectLocalEndpoint(endpoint: string, posixEndpoint: string): void {
  if (process.platform === "win32") {
    expect(endpoint).toMatch(/^\\\\\.\\pipe\\redskilled-[a-f0-9]{12}-(?:acp|worker-[a-z0-9-]+)$/);
    return;
  }
  expect(endpoint).toBe(posixEndpoint);
}
