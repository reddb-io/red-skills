#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encode, type JsonValue } from "@reddb-io/toon";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCastleMcpTools } from "@reddb-io/red-castle/mcp-server";
import {
  createEnginePaths,
  createFileIssueCuratorStore,
  armPr,
  createFileMergeDriverStore,
  createGitHubTrackerAdapter,
  createLaneFollower,
  createSingletonLeaseStore,
  listCastleLaneFiles,
  runIssueStateCurator,
  runMergeDriverPass,
} from "@reddb-io/red-castle/engine";
import {
  registerLaneEventSubscription,
  type LaneSubscriptionServer,
} from "./lane-subscription.js";
import { HOST_STATE_TRANSITION_LABELS } from "./core/state-transition.js";
import { createMergeDriverIo } from "./runtime/merge-driver-io.js";
import { createMedicIo } from "./runtime/medic-io.js";
import { createFileMedicStore, runMedicPass } from "./core/pr-medic.js";
import { resolveRepoContext, resolveRepoSlug } from "./runtime/wire.js";
import {
  buildSupervisorBootSweeps,
  superviseCommand,
} from "./commands/supervise.js";
import { createCastleMcpDependencies } from "./mcp-adapter.js";
import {
  createResidentWebhook,
  type ResidentWebhook,
} from "./resident-webhook.js";
import {
  createResidentJanitor,
  type ResidentJanitor,
} from "./resident-cron.js";

const buildInfo = readBuildInfo("castle");

function toon(value: unknown): string {
  return encode(JSON.parse(JSON.stringify(value ?? null)) as JsonValue, {
    keyedMapCollapse: true,
  });
}

export function createCastleMcpServer(root = process.cwd()): McpServer {
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
  const paths = createEnginePaths(join(root, ".red"));
  registerLaneEventSubscription(
    server.server as unknown as LaneSubscriptionServer,
    createLaneFollower({
      list: () => listCastleLaneFiles(paths, ["worker", "supervisor"]),
    }),
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
  readonly resident: ResidentWebhook;
  readonly janitor: ResidentJanitor;
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
  const server = createCastleMcpServer();
  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    let sharedBootSweeps: (() => Promise<void>) | undefined;
    await connectResidentMcp({
      server,
      transport: new StdioServerTransport(),
      resident: createResidentWebhook({ root }),
      janitor: createResidentJanitor({
        root,
        sweep: async () => {
          if (!sharedBootSweeps) {
            const repo = await resolveRepoSlug(root).catch(() => "");
            sharedBootSweeps = buildSupervisorBootSweeps(root, repo, (line) =>
              process.stderr.write(`castle resident: ${line}\n`),
            );
          }
          await sharedBootSweeps();
        },
        notice: (line) => process.stderr.write(`castle resident: ${line}\n`),
      }),
    });
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}

export const RESIDENT_CURATOR_INTERVAL_MS = 5 * 60 * 1000;
export const RESIDENT_MERGE_DRIVER_INTERVAL_MS = 90 * 1000;

/** Start the #2512 merge driver inside the castle resident: every interval it
 * reloads the durable armed set from `.red/state/castle/merge-driver.toon` and
 * runs one pass (update-branch when BEHIND, merge-commit when green, bounded
 * retries, terminal classification). A singleton lease keeps multiple stdio
 * hosts for the same repo off the same store; an empty armed set costs one
 * file read and no gh call. */
export async function startResidentMergeDriver(root = process.cwd()): Promise<void> {
  const paths = createEnginePaths(join(root, ".red"));
  const owner = { pid: process.pid, startTime: new Date().toISOString() };
  const lease = await createSingletonLeaseStore(paths).acquire("merge-driver", owner);
  if (!lease.acquired) return;

  const store = createFileMergeDriverStore(paths);
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const state = await store.read();
      const armed = Object.values(state.prs).some((record) => record.status === "armed");
      if (armed) {
        const context = await resolveRepoContext(root);
        const entries = await runMergeDriverPass(
          createMergeDriverIo({ cwd: context.root, repo: context.repo }),
          store,
          { nowEpoch: Math.floor(Date.now() / 1000) },
        );
        // PR medic (#2513): a terminal needs-medic classification gets ONE
        // bounded mechanical healing round before any human sees it. A healed
        // push re-arms the PR so the driver resumes ownership; the medic's own
        // ledger escalates after MEDIC_MAX_ROUNDS failed rounds.
        for (const entry of entries) {
          if (entry.action !== "terminal-medic") continue;
          try {
            const medic = await runMedicPass(
              createMedicIo(context.root),
              createFileMedicStore(paths),
              entry.pr,
              { nowEpoch: Math.floor(Date.now() / 1000) },
            );
            if (medic.outcome === "healed") {
              await armPr(store, entry.pr, Math.floor(Date.now() / 1000));
            }
          } catch {
            // A failed heal leaves the terminal classification standing.
          }
        }
      }
    } catch {
      // Transport faults retry on the next interval; the resident never dies here.
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), RESIDENT_MERGE_DRIVER_INTERVAL_MS);
  timer.unref();
}

/** Start the ADR 0122 periodic reconciliation owner inside the castle resident.
 * The singleton lease prevents multiple stdio hosts for the same repo from
 * racing the durable ledger. The first sweep is detached from MCP startup; a
 * slow or unavailable tracker never delays the stdio handshake. */
export async function startResidentIssueCurator(
  root = process.cwd(),
): Promise<void> {
  const paths = createEnginePaths(join(root, ".red"));
  const owner = { pid: process.pid, startTime: new Date().toISOString() };
  const lease = await createSingletonLeaseStore(paths).acquire(
    "issue-curator",
    owner,
  );
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
      await runIssueStateCurator({ tracker, store, labels: HOST_STATE_TRANSITION_LABELS });
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
  startMergeDriver(): Promise<void>;
  connect(): Promise<void>;
  /** The lane's own canary (#2706). Optional so every existing caller keeps
   * working; omitted means the real probe. */
  canary?(args: string[]): Promise<number>;
}

/**
 * Usage, as a CONSTANT — the roles this bundle owns, stated without a transport.
 *
 * `--help` used to fall into the unroutable-subcommand error, so the one command
 * that says which subcommands exist answered by refusing an unknown one (#2918).
 * Like `--version`, it is asked when the surrounding machinery is broken.
 */
export const CASTLE_MCP_USAGE = `Usage: red-skills-castle-mcp [command]

Commands:
  (none)        serve the castle MCP surface over stdio
  __supervise   run the supervisor role from this same bundle
  --version     print the build stamp (--json for the build info)
  --help        print this usage

Worker subcommands (run, monitor, fleet, …) belong to red-skills-dev.
`;

/** Route every executable role shipped in the afk-mcp bundle. The supervisor
 * launcher deliberately re-execs the current bundle, so `__supervise` must be
 * handled before the default stdio MCP transport is opened. */
export async function main(
  argv = process.argv.slice(2),
  dependencies: McpEntrypointDependencies = {
    supervise: superviseCommand,
    startCurator: startResidentIssueCurator,
    startMergeDriver: startResidentMergeDriver,
    connect: run,
  },
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(CASTLE_MCP_USAGE);
    return 0;
  }
  if (argv[0] === "__supervise") {
    return dependencies.supervise(argv.slice(1));
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
  // open a SECOND resident/stdio host that contends on the singleton leases and
  // dies with an opaque lease error, which is exactly how MCP-launched slots
  // burned as `deaths == respawns` forever (#2677). Fail with a named error
  // instead, so the misrouted spawn is legible in the slot log.
  const leading = argv[0];
  if (leading !== undefined) {
    process.stderr.write(
      `castle MCP: unroutable subcommand ${JSON.stringify(leading)} — ` +
        "the castle-mcp bundle routes only `__supervise` and `--version`; " +
        "worker subcommands belong to the dev entry (red-skills-dev)\n",
    );
    return 2;
  }
  await dependencies.startCurator();
  await dependencies.startMergeDriver();
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
      process.stderr.write(`castle MCP fatal: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
