#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { connectRedskillsProjectAcp } from "@reddb-io/redskilled/acp-client";
import type { RedskilledGithubRequest } from "@reddb-io/protocol-acp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASTLE_MCP_PROMPTS,
  createCastleMcpTools,
  RS_DEV_MCP_SERVER_NAME,
  type CastleMcpDependencies,
} from "./mcp-tools/index.js";
import { encodeRedskilledMcpToon } from "./mcp-toon.js";
import { invokeProjectMcp } from "./project-acp-adapter.js";
import { drainInputFor } from "./core/drain-registration-resolve.js";
import { ensureStandingDrain } from "./runtime/standing-drain-start.js";
import {
  registerLaneEventSubscription,
  type LaneSubscriptionServer,
} from "./lane-subscription.js";
import { createAcpLaneFollower } from "./acp-lane-follower.js";
import { createRsGithubMcpServer, RS_GITHUB_REQUEST_METHOD } from "./mcp-github/index.js";

const buildInfo = readBuildInfo("redskilled-mcp");

export function createRedskilledMcpServer(
  root: string | (() => string | Promise<string>) = process.cwd(),
  acpInvoke?: (method: string, input: Record<string, unknown>) => Promise<unknown>,
): McpServer {
  const server = new McpServer({ name: RS_DEV_MCP_SERVER_NAME, version: buildInfo.version });
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
  // **A drain that carries no work registers nothing** (#4101). The daemon
  // births only for a registration, and this process is the one that knows what
  // this project's work IS — a repository, a ready label, a target. Building it
  // here rather than in a tool handler keeps the tool a schema and the semantics
  // where the checkout is.
  // Since #4293 the same seam also completes an UNDERSPECIFIED drain from the
  // project's `afk.standing` declaration, so `drain` with no runner argument
  // runs the executor the repository declared rather than the governed default.
  // The root may be a SUPPLIER: the ACP session binds to the resolved project
  // root, and a registration built from this process's launch cwd instead names
  // the wrong checkout — `repositoryOf` then fails and the drain silently
  // records intent without a registration (#4101's shape, reopened live).
  const resolveRoot = async (): Promise<string> => (typeof root === "string" ? root : await root());
  const enrich = async (tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (tool !== "drain" || input.registration != null) return input;
    let resolved: string;
    try {
      resolved = await resolveRoot();
    } catch (error) {
      throw new Error(
        `rs_dev drain cannot build its registration: the session's project root did not resolve (${
          error instanceof Error ? error.message : String(error)}); a drain without a registration would record intent nothing acts on, so it is refused instead`,
      );
    }
    return drainInputFor(resolved, buildInfo.version, input);
  };
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
              await invoke(tool.name, await enrich(tool.name, input)),
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
  /**
   * Ran once the stdio transport is live, before the session serves anything.
   *
   * Synchronous and unawaited on purpose: this is where boot-time project work
   * goes, and boot-time project work that can block would hold the tool surface
   * hostage to a daemon that is not answering.
   */
  readonly afterConnect?: () => void;
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
  options.afterConnect?.();
  await closed;
}

/**
 * Serve `rs_github` over the same stdio lane, against the same daemon.
 *
 * Two MCP surfaces share one bundle because they share one client: a second
 * binary would duplicate the launcher, the version stamp and the packaging for
 * a process whose entire body is an envelope and a socket. Which surface a host
 * mounts is its argv, not its download.
 */
async function runRsGithub(): Promise<void> {
  const fallbackRoot = process.cwd();
  let projectPromise: ReturnType<typeof connectRedskillsProjectAcp> | undefined;
  let server!: McpServer;
  const project = () => {
    projectPromise ??= resolveMcpProjectRoot(server.server, process.env, fallbackRoot).then((root) =>
      connectRedskillsProjectAcp({
        cwd: root,
        name: "RedSkills GitHub MCP adapter",
        version: buildInfo.version,
      }));
    return projectPromise;
  };
  server = createRsGithubMcpServer({
    version: buildInfo.version,
    invoke: async (method, params) => {
      if (method !== RS_GITHUB_REQUEST_METHOD) {
        throw new Error(`rs_github: no daemon method ${JSON.stringify(method)}`);
      }
      const session = await project();
      return session.github((params as { request: RedskilledGithubRequest }).request);
    },
  });
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await connectProjectMcp({ server, transport: new StdioServerTransport() });
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

async function run(): Promise<void> {
  const fallbackRoot = process.cwd();
  let projectPromise: ReturnType<typeof connectRedskillsProjectAcp> | undefined;
  let rootPromise: Promise<string> | undefined;
  let server!: McpServer;
  const projectRoot = () =>
    (rootPromise ??= resolveMcpProjectRoot(server.server, process.env, fallbackRoot));
  const project = () => {
    projectPromise ??= projectRoot().then((root) =>
      connectRedskillsProjectAcp({
        cwd: root,
        name: "RedSkills MCP adapter",
        version: buildInfo.version,
      }));
    return projectPromise;
  };
  server = createRedskilledMcpServer(projectRoot, async (method, input) =>
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
      // **The declaration registers here or nowhere** (#4293). This is the one
      // surface an enabled project runs without a human typing anything, so a
      // registration the daemon lost to a restart is re-stated by the next
      // session. Fired and not awaited: `ensureStandingDrain` never rejects, and
      // the stdio lane must start serving whatever the daemon is doing.
      afterConnect: () => {
        void ensureStandingDrain({
          version: buildInfo.version,
          root: projectRoot,
          drain: async (input) => invokeProjectMcp(await project(), "drain", input),
        });
      },
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
  /** Serve `rs_github` instead of `rs_dev`. Chosen by argv, never by config. */
  connectGithub?(): Promise<void>;
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
  (none)        serve the rs_dev MCP surface over stdio
  github        serve the rs_github MCP surface over stdio
  --version     print the build stamp (--json for the build info)
  --help        print this usage

Workflow verbs are rs_dev tools, and Worker lifecycle is the redskilled
daemon's own argv (ADR 0147 rule 1). Neither is a subcommand of this bundle.
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
  if (argv[0] === "github") {
    await (dependencies.connectGithub ?? runRsGithub)();
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    process.stdout.write(
      argv.includes("--json")
        ? `${JSON.stringify(buildInfo)}\n`
        : `${renderVersion(buildInfo)}\n`,
    );
    return 0;
  }
  // Any OTHER leading token is a role this bundle does not own. It used to
  // belong to the dev entry; since ADR 0147 rule 1 there IS no dev entry, so a
  // workflow verb is an `rs_dev` tool and Worker lifecycle is the daemon's argv.
  // Falling through would open an unintended Project surface, so fail with a
  // named error instead and keep a misrouted launch legible in the adapter log.
  const leading = argv[0];
  if (leading !== undefined) {
    process.stderr.write(
      `redskilled MCP: unroutable subcommand ${JSON.stringify(leading)} — ` +
        "the redskilled-mcp bundle routes only `--version` and `--help`; " +
        "a workflow verb is an `rs_dev` tool and Worker lifecycle is `redskilled`\n",
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
