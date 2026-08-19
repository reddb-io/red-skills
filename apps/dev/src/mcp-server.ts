#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { connectRedskillsProjectAcp } from "@reddb-io/redskilled/acp-client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASTLE_MCP_PROMPTS,
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "@reddb-io/worker/mcp-server";
import { encodeRedskilledMcpToon } from "./mcp-toon.js";
import { invokeProjectMcp } from "./project-acp-adapter.js";
import {
  registerLaneEventSubscription,
  type LaneSubscriptionServer,
} from "./lane-subscription.js";
import { createAcpLaneFollower } from "./acp-lane-follower.js";

const buildInfo = readBuildInfo("redskilled-mcp");

export function createRedskilledMcpServer(
  root = process.cwd(),
  acpInvoke?: (method: string, input: Record<string, unknown>) => Promise<unknown>,
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
  // Tool schemas stay local so MCP discovery needs no ACP round-trip. When
  // an ACP invoker is present the dependency object is deliberately empty:
  // every invocation is replaced below, so this process owns no engine port.
  const invoke = acpInvoke ?? (async () => {
    throw new Error("REDSKILLED_ACP_UNAVAILABLE: the stdio adapter has no ACP client");
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
    createAcpLaneFollower(invoke),
  );
  return server;
}

export interface ProjectMcpConnection {
  readonly server: { onclose?: () => void };
  connect(transport: StdioServerTransport): Promise<void>;
}

export interface ConnectProjectMcpOptions {
  readonly server: ProjectMcpConnection;
  readonly transport: StdioServerTransport;
}

export interface McpRootClient {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(): Promise<{ roots: Array<{ uri: string }> }>;
}

export async function resolveMcpProjectRoot(
  client: McpRootClient,
  env: NodeJS.ProcessEnv = process.env,
  fallback = process.cwd(),
): Promise<string> {
  const explicit = (
    env.RED_SKILLS_PROJECT_ROOT ??
    env.CLAUDE_PROJECT_DIR ??
    env.CODEX_PROJECT_DIR ??
    env.OPENCODE_PROJECT_DIR ??
    ""
  ).trim();
  if (explicit !== "") return resolve(explicit);

  if (client.getClientCapabilities()?.roots !== undefined) {
    try {
      const listed = await client.listRoots();
      for (const root of listed.roots) {
        if (root.uri.startsWith("file:")) return resolve(fileURLToPath(root.uri));
      }
    } catch {
      // Clients may advertise roots but refuse the optional request; cwd remains
      // the compatibility fallback for source-checkout launchers.
    }
  }
  return resolve(fallback);
}

export async function connectProjectMcp(
  options: ConnectProjectMcpOptions,
): Promise<void> {
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    notifyClosed = resolveClosed;
  });
  options.server.server.onclose = notifyClosed;
  await options.server.connect(options.transport);
  await closed;
}

async function run(): Promise<void> {
  const fallbackRoot = process.cwd();
  let projectPromise: ReturnType<typeof connectRedskillsProjectAcp> | undefined;
  let server!: McpServer;
  const project = () => {
    projectPromise ??= resolveMcpProjectRoot(server.server, process.env, fallbackRoot).then((root) =>
      connectRedskillsProjectAcp({
        cwd: root,
        name: "RedSkills MCP adapter",
        version: buildInfo.version,
      }));
    return projectPromise;
  };
  server = createRedskilledMcpServer(fallbackRoot, async (method, input) =>
    invokeProjectMcp(await project(), method, input));
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await connectProjectMcp({
      server,
      transport: new StdioServerTransport(),
    });
  } finally {
    if (projectPromise !== undefined) {
      try {
        (await projectPromise).close();
      } catch {
        // A failed lazy ACP connection has no live transport to close.
      }
    }
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}

export interface McpEntrypointDependencies {
  connect(): Promise<void>;
  /** The lane's own canary (#2706). Optional so every existing caller keeps
   * working; omitted means the real probe. */
  canary?(args: string[]): Promise<number>;
  /** Old injected test keys are ignored; production consults only ACP. */
  readonly [legacyDependency: string]: unknown;
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
  --help        print this usage

Worker subcommands (run, monitor, fleet, …) belong to red-skills-dev.
`;

/** Route every executable role shipped in the afk-mcp bundle. Since ADR 0130
 * Amendment 4 a project contributes a registration rather than a process, so the
 * only roles here are the stdio MCP surface, the lane canary and `--version`. */
export async function main(
  argv = process.argv.slice(2),
  dependencies: McpEntrypointDependencies = {
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
  // open an unintended Project surface. Fail with a named error instead, so a
  // misrouted launch is legible in the adapter log.
  const leading = argv[0];
  if (leading !== undefined) {
    process.stderr.write(
      `redskilled MCP: unroutable subcommand ${JSON.stringify(leading)} — ` +
        "the redskilled-mcp bundle routes only `--version` and `--help`; " +
        "worker subcommands belong to the dev entry (red-skills-dev)\n",
    );
    return 2;
  }
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
