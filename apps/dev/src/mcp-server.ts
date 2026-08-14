#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { deathLaneFile, installDeathRecorder } from "@reddb-io/shared/death-record.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASTLE_MCP_PROMPTS,
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "@reddb-io/red-castle/mcp-server";
import { CastleResidentClient } from "@reddb-io/red-castle/resident";
import { encodeRedskilledMcpToon } from "./mcp-toon.js";
import {
  registerLaneEventSubscription,
  type LaneSubscriptionServer,
} from "./lane-subscription.js";
import { createResidentLaneFollower } from "./resident-lane-follower.js";

const buildInfo = readBuildInfo("redskilled-mcp");

export function createRedskilledMcpServer(
  root = process.cwd(),
  residentInvoke?: (method: string, input: Record<string, unknown>) => Promise<unknown>,
): McpServer {
  const server = new McpServer({ name: "redskilled", version: buildInfo.version });
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
  // Tool schemas stay local so MCP discovery needs no resident round-trip. When
  // a resident invoker is present the dependency object is deliberately empty:
  // every invocation is replaced below, so this process owns no engine port.
  const invoke = residentInvoke ?? (async () => {
    throw new Error("CASTLE_RESIDENT_UNAVAILABLE: the stdio proxy has no resident client");
  });
  const dependencies = {} as CastleMcpDependencies;
  for (const tool of createCastleMcpTools(dependencies)) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => ({
        content: [
          {
            type: "text" as const,
            text: encodeRedskilledMcpToon(
              await invoke(tool.name, input),
            ),
          },
        ],
      }),
    );
  }
  for (const prompt of CASTLE_MCP_PROMPTS) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
      },
      async () => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: prompt.body },
          },
        ],
      }),
    );
  }
  registerLaneEventSubscription(
    server.server as unknown as LaneSubscriptionServer,
    createResidentLaneFollower(invoke),
  );
  return server;
}

export interface ResidentMcpConnection {
  readonly server: { onclose?: () => void };
  connect(transport: StdioServerTransport): Promise<void>;
}

export interface ConnectResidentMcpOptions {
  readonly server: ResidentMcpConnection;
  readonly transport: StdioServerTransport;
  readonly resident: ResidentLeaseComponent;
  readonly janitor: ResidentLeaseComponent;
}

export interface ResidentLeaseComponent {
  start(): Promise<unknown>;
  stop(): Promise<void>;
}

export async function connectResidentMcp(
  options: ConnectResidentMcpOptions,
): Promise<void> {
  await options.resident.start();
  await options.janitor.start();
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    notifyClosed = resolveClosed;
  });
  options.server.server.onclose = notifyClosed;
  try {
    await options.server.connect(options.transport);
    await closed;
  } finally {
    await Promise.all([options.janitor.stop(), options.resident.stop()]);
  }
}

async function run(): Promise<void> {
  const root = process.cwd();
  // The launcher's own black box (Spec #3022, slice #3023). The resident is where
  // work is ASKED for, so a resident that vanished mid-session used to take the
  // reason with it; it now writes the same record a worker and the host daemon
  // write, to the same lane, on every trap-able exit.
  const deaths = installDeathRecorder({
    lanePath: deathLaneFile(root),
    kind: "launcher",
    id: `redskilled-mcp:${process.pid}`,
    phase: "connecting",
  });
  const client = new CastleResidentClient({
    cwd: root,
    clientVersion: buildInfo.version,
    serverCommand: process.execPath,
    serverArgs: [fileURLToPath(import.meta.url), "__castle-resident"],
  });
  await client.open();
  const server = createRedskilledMcpServer(root, (method, input) => client.call(method, input));
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    deaths.phase("serving");
    const inertLease = {
      acquired: false as const,
      lease: {
        pid: process.pid,
        start_time: "client",
        acquired_at: "client",
        renewed_at: "client",
      },
    };
    await connectResidentMcp({
      server,
      transport: new StdioServerTransport(),
      resident: { start: async () => inertLease, stop: async () => undefined },
      janitor: { start: async () => inertLease, stop: async () => undefined },
    });
  } finally {
    await client.close();
    deaths.phase("closing");
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}

/** Resolve the resident shipped beside this MCP bundle, preserving cache keys. */

export interface McpEntrypointDependencies {
  startCurator(): Promise<void>;
  startMergeDriver(): Promise<void>;
  /** The #3014 Unblock belt: the session-reachable clearer for a dependent whose
   * last `req:*` blocker closed. Optional so every existing caller keeps
   * working; omitted means the belt does not run in that host. */
  startUnblockSweep?(): Promise<void>;
  /** The #3178 bundle belt: refresh a SessionStart verdict throughout a
   * long-lived session. Optional for compatibility with injected test hosts. */
  startSelfUpdate?(): Promise<void>;
  connect(): Promise<void>;
  /** The lane's own canary (#2706). Optional so every existing caller keeps
   * working; omitted means the real probe. */
  canary?(args: string[]): Promise<number>;
  /** The Castle resident, run as a role of this same bundle. Optional so every
   * existing caller keeps working; omitted means the real resident. */
  resident?(args: string[]): Promise<number>;
}

/**
 * Usage, as a CONSTANT — the roles this bundle owns, stated without a transport.
 *
 * `--help` used to fall into the unroutable-subcommand error, so the one command
 * that says which subcommands exist answered by refusing an unknown one (#2918).
 * Like `--version`, it is asked when the surrounding machinery is broken.
 */
export const REDSKILLED_MCP_USAGE = `Usage: red-skills-redskilled-mcp [command]

Commands:
  (none)        serve the redskilled MCP surface over stdio
  --version     print the build stamp (--json for the build info)
  __castle-resident   run the project's Castle resident (spawned, not typed)
  --help        print this usage

Worker subcommands (run, monitor, fleet, …) belong to red-skills-dev.
`;

/** Route every executable role shipped in the afk-mcp bundle. Since ADR 0130
 * Amendment 4 a project contributes a registration rather than a process, so the
 * only roles here are the stdio MCP surface, the lane canary and `--version`. */
export async function main(
  argv = process.argv.slice(2),
  dependencies: McpEntrypointDependencies = {
    // The dedicated Castle resident owns every belt. The stdio MCP is only a
    // client and must not start a second in-process authority.
    startCurator: async () => undefined,
    startMergeDriver: async () => undefined,
    startUnblockSweep: async () => undefined,
    startSelfUpdate: async () => undefined,
    connect: run,
  },
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(REDSKILLED_MCP_USAGE);
    return 0;
  }
  // The lane's canary lives in THIS bundle on purpose (#2706): it must launch
  // the shipped MCP entry over the real transport, and the dev bundle contract
  // forbids the client SDK's bundled `require()` calls landing there.
  if (argv[0] === "__mcp-canary") {
    const canary =
      dependencies.canary ??
      (async (args: string[]) =>
        (await import("./commands/mcp-lane-canary.js")).mcpLaneCanaryCommand(args));
    return canary(argv.slice(1));
  }
  // The resident is a ROLE of this bundle, not a second artifact (#3804 shipped
  // it as a sibling file, which made five places enforce that two files travel
  // together). The process boundary ADR 0143 asks for is unchanged: this branch
  // runs in the process the proxy SPAWNS, so the stdio host still owns no engine
  // and still crosses the socket for every call. Dynamic, like `__mcp-canary`
  // above, so the static serve path imports no engine module.
  if (argv[0] === "__castle-resident") {
    const resident =
      dependencies.resident ??
      (async () => {
        await (await import("./castle-resident.js")).runCastleResident();
        return 0;
      });
    return resident(argv.slice(1));
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    process.stdout.write(
      argv.includes("--json")
        ? `${JSON.stringify(buildInfo)}\n`
        : `${renderVersion(buildInfo)}\n`,
    );
    return 0;
  }
  // Any OTHER leading token is a role this bundle does not own — `run`,
  // `--once`, `monitor`, … all belong to the dev entry. Falling through would
  // open a SECOND resident/stdio host that contends on the singleton leases and
  // dies with an opaque lease error, which is exactly how MCP-launched slots
  // burned as `deaths == respawns` forever (#2677). Fail with a named error
  // instead, so the misrouted spawn is legible in the slot log.
  const leading = argv[0];
  if (leading !== undefined) {
    process.stderr.write(
      `redskilled MCP: unroutable subcommand ${JSON.stringify(leading)} — ` +
        "the redskilled-mcp bundle routes only `--version` and `--help`; " +
        "worker subcommands belong to the dev entry (red-skills-dev)\n",
    );
    return 2;
  }
  await dependencies.startCurator();
  // ADR 0136: the session-bound merge loop is retired. Native auto-merge holds
  // the durable intent and the Queue Custodian invokes the merge-driver state
  // machine only as a recovery arm after an observed ejection; opening an MCP
  // session must not create a second watcher.
  // Started BEFORE the transport (#3014): its first pass is the session-boot
  // clearer, and it is detached inside, so a slow tracker delays no handshake.
  await dependencies.startUnblockSweep?.();
  // Like the other belts, this starts before stdio and detaches its first pass:
  // an eight-hour session keeps learning about releases after its first second.
  await dependencies.startSelfUpdate?.();
  await dependencies.connect();
  return 0;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  void main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`redskilled MCP fatal: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
