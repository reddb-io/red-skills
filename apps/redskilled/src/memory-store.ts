// memory-store — the Project memory handles the daemon holds (ADR 0152).
//
// Memory used to be a heavy MCP that opened its own RedDB in the session
// process: N sessions on one repository meant N open handles on one store, and
// a Worker in a daemon-placed workspace had no repository store to open at all.
// ADR 0152 moved both problems here — the store is the PROJECT's, it lives at
// `~/.red/memory/<project-id>`, and the daemon holds it once per host.
//
// The memo below is that decision made mechanical, and it is keyed by RESOLVED
// ROOT rather than by Project: a repository that opted its checkout in has two
// legitimate roots — its own and the Project's — and two callers who resolved
// to the same root must share one handle no matter which Project they bound.
//
// Two callers that arrive together share one open, because the PROMISE is
// cached rather than the handle: caching the handle would let the second caller
// start a second open while the first was still in flight, which is exactly the
// N-handles shape this replaced. A failed open drops the memo so a transient
// failure does not poison the host until the daemon restarts.
import { homedir } from "node:os";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  RedskilledMemoryAnswer,
  RedskilledMemoryCall,
} from "@reddb-io/protocol-acp";

import {
  resolveProjectMemoryRoot,
  type ResolvedProjectMemoryRoot,
} from "./memory-root.js";
import type { AcpProjectIdentity } from "./project-workspace.js";

/**
 * The memory engine, as the daemon reaches it.
 *
 * A PORT rather than a direct import so the daemon's own tests can serve memory
 * without a RedDB, and so the engine's eventual move out of the memory app is
 * one import site rather than a sweep. What crosses it is deliberately narrow:
 * open a root, list what it publishes, run one tool, close.
 */
export interface MemoryEnginePort {
  open(root: string): Promise<OpenedMemoryStore>;
}

/** One open memory store, and the tool body that answers against it. */
export interface OpenedMemoryStore {
  /** Every tool this store publishes — the core plus the generated operations. */
  tools(): Promise<readonly MemoryToolDescriptor[]>;
  /** Run one tool. The result travels back to the caller's MCP host unchanged. */
  call(tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

/** One published tool, as a session lists it. */
export interface MemoryToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ProjectMemoryStoreDeps {
  /** Where HOME is. Production reads the daemon process's own environment. */
  readonly env?: Record<string, string | undefined>;
  /** The engine. Production lazily reaches the memory app's tool body. */
  readonly engine?: MemoryEnginePort;
}

/** The per-Project memory every ACP connection on this host shares. */
export interface ProjectMemoryStore {
  /** Serve one memory tool call for one Project, opening its store on first use. */
  call(project: AcpProjectIdentity, call: RedskilledMemoryCall): Promise<RedskilledMemoryAnswer>;
  /** Close every held store. */
  close(): Promise<void>;
}

/**
 * Create the daemon's memory holder. Call this ONCE per daemon, never per
 * connection — a holder per connection is a handle per session wearing a
 * different name.
 */
export function createProjectMemoryStore(deps: ProjectMemoryStoreDeps = {}): ProjectMemoryStore {
  const env = deps.env ?? process.env;
  const engine = deps.engine ?? lazyMemoryEngine(env);
  const held = new Map<string, Promise<OpenedMemoryStore>>();

  const opened = (root: string): Promise<OpenedMemoryStore> => {
    const existing = held.get(root);
    if (existing != null) return existing;
    const pending = engine.open(root).catch((error: unknown) => {
      held.delete(root);
      throw error;
    });
    held.set(root, pending);
    return pending;
  };

  return {
    async call(project, call) {
      const resolved = await resolveProjectMemoryRoot({
        projectId: project.projectId,
        checkoutRoot: project.checkoutRoot,
        home: homeDirectory(env),
        mode: call.mode,
      });
      const store = await opened(resolved.root);
      return {
        tool: call.tool,
        root: resolved.root,
        scope: resolved.scope,
        result: await serveMemoryCall(store, call, resolved),
      };
    },
    async close() {
      const pending = [...held.values()];
      held.clear();
      await Promise.all(pending.map(async (store) => {
        try {
          await (await store).close();
        } catch {
          // A store that failed to open has no handle to close.
        }
      }));
    },
  };
}

/** The surface probe, answered here; everything else is the engine's. */
const SURFACE_TOOL = "memory_tools";

/**
 * Run one call against one open store.
 *
 * `memory_tools` is answered HERE rather than by the engine because it is a
 * question about the daemon's own resolution as much as about the surface: the
 * root and scope it reports are what let an operator see which memory their
 * session is actually listing.
 */
async function serveMemoryCall(
  store: OpenedMemoryStore,
  call: RedskilledMemoryCall,
  resolved: ResolvedProjectMemoryRoot,
): Promise<unknown> {
  const tools = await store.tools();
  if (call.tool === SURFACE_TOOL) {
    return { tools, root: resolved.root, scope: resolved.scope, reason: resolved.reason };
  }
  if (!tools.some((tool) => tool.name === call.tool)) {
    throw RequestError.invalidParams(
      {},
      `${resolved.root} publishes no memory tool named ${JSON.stringify(call.tool)} — ` +
        `call ${SURFACE_TOOL} for the surface this Project's store answers`,
    );
  }
  return await store.call(call.tool, call.arguments);
}

/** The memory plugin's tool body, as the daemon resolves it at run time. */
interface MemoryEngineModule {
  openMemoryToolContext(root: string): Promise<{ store: { close(): Promise<void> } }>;
  memoryToolDescriptors(): MemoryToolDescriptor[];
  serveMemoryTool(
    context: unknown,
    name: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

/** Where the engine is asked for. Overridable so a host can name an installed tree. */
export const MEMORY_ENGINE_MODULE_ENV = "RED_MEMORY_ENGINE_MODULE";
const MEMORY_ENGINE_MODULE = "@reddb-io/memory/mcp-server/serve.js";

/**
 * The production engine, resolved the first time a call needs one.
 *
 * Resolved at RUN time, from the installed tree, rather than compiled in
 * (ADR 0146). Two reasons, and the second is the load-bearing one:
 *
 *  1. The daemon serves Projects that never mount the memory plugin, and a
 *     graph engine loaded at boot is one every host pays for whether or not
 *     anybody asked memory a question.
 *  2. **Memory is a plugin, and the daemon is not built out of its plugins.**
 *     The memory app already reaches the daemon for its ACP client; a build
 *     edge back the other way would make the two mutually dependent, which is
 *     an ordering nobody can satisfy and a cycle a workspace only warns about.
 *
 * The shape it must have is declared above and pinned from the producer's side
 * by `apps/plugin-memory/tests/mcp-serve-contract.test.ts` — a rename there fails that
 * test rather than surviving to fail here, on a host, at the first memory call
 * of the day.
 */
function lazyMemoryEngine(env: Record<string, string | undefined>): MemoryEnginePort {
  const specifier = env[MEMORY_ENGINE_MODULE_ENV]?.trim() || MEMORY_ENGINE_MODULE;
  return {
    async open(root) {
      const engine = await import(specifier).catch((error: unknown) => {
        throw new Error(
          `redskilled cannot serve memory: ${specifier} did not load — install the memory ` +
            `plugin on this host, or name its module in ${MEMORY_ENGINE_MODULE_ENV}. ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }) as MemoryEngineModule;
      const context = await engine.openMemoryToolContext(root);
      return {
        tools: async () => engine.memoryToolDescriptors(),
        call: async (tool, args) => await engine.serveMemoryTool(context, tool, args),
        close: () => context.store.close(),
      };
    },
  };
}

/** Where the host-scoped Project stores hang off. */
function homeDirectory(env: Record<string, string | undefined>): string {
  return env["HOME"] ?? env["USERPROFILE"] ?? homedir();
}
