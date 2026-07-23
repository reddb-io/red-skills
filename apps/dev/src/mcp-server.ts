#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encode, type JsonValue } from "@reddb-io/toon";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCastleMcpTools } from "../../../packages/red-castle/src/mcp-server.js";
import {
  createEnginePaths,
  createFileIssueCuratorStore,
  createGitHubTrackerAdapter,
  createSingletonLeaseStore,
  runIssueStateCurator,
} from "@reddb-io/red-castle/engine";
import { superviseCommand } from "./commands/supervise.js";
import { createCastleMcpDependencies } from "./mcp-adapter.js";

const buildInfo = readBuildInfo("castle");

function toon(value: unknown): string {
  return encode(JSON.parse(JSON.stringify(value ?? null)) as JsonValue, {
    keyedMapCollapse: true,
  });
}

export function createCastleMcpServer(): McpServer {
  const server = new McpServer({ name: "castle", version: buildInfo.version });
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
    },
    handler: (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
    }>,
  ) => void;
  for (const tool of createCastleMcpTools(createCastleMcpDependencies())) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => ({
        content: [
          { type: "text" as const, text: toon(await tool.invoke(input)) },
        ],
      }),
    );
  }
  return server;
}

async function run(): Promise<void> {
  await createCastleMcpServer().connect(new StdioServerTransport());
}

export const RESIDENT_CURATOR_INTERVAL_MS = 5 * 60 * 1000;

/** Start the ADR 0122 periodic reconciliation owner inside the castle resident.
 * The singleton lease prevents multiple stdio hosts for the same repo from
 * racing the durable ledger. The first sweep is detached from MCP startup; a
 * slow or unavailable tracker never delays the stdio handshake. */
export async function startResidentIssueCurator(root = process.cwd()): Promise<void> {
  const paths = createEnginePaths(join(root, ".red"));
  const owner = { pid: process.pid, startTime: new Date().toISOString() };
  const lease = await createSingletonLeaseStore(paths).acquire("issue-curator", owner);
  if (!lease.acquired) return;

  const tracker = createGitHubTrackerAdapter({
    claimLockRoot: join(paths.tmpRoot, "claims"),
  });
  const store = createFileIssueCuratorStore(paths);
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runIssueStateCurator({ tracker, store });
    } catch {
      // Repo-level transport/state faults retry on the permanent periodic belt;
      // they must not terminate the resident or block its MCP surface.
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), RESIDENT_CURATOR_INTERVAL_MS);
  timer.unref();
}

export interface McpEntrypointDependencies {
  supervise(args: string[]): Promise<number>;
  startCurator(): Promise<void>;
  connect(): Promise<void>;
}

/** Route every executable role shipped in the afk-mcp bundle. The supervisor
 * launcher deliberately re-execs the current bundle, so `__supervise` must be
 * handled before the default stdio MCP transport is opened. */
export async function main(
  argv = process.argv.slice(2),
  dependencies: McpEntrypointDependencies = {
    supervise: superviseCommand,
    startCurator: startResidentIssueCurator,
    connect: run,
  },
): Promise<number> {
  if (argv[0] === "__supervise") {
    return dependencies.supervise(argv.slice(1));
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    process.stdout.write(
      argv.includes("--json")
      ? `${JSON.stringify(buildInfo)}\n`
      : `${renderVersion(buildInfo)}\n`,
    );
    return 0;
  }
  await dependencies.startCurator();
  await dependencies.connect();
  return 0;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`castle MCP fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
