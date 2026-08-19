// brain-store — the host's ONE brain store handle (ADR 0152).
//
// Brain used to be a heavy MCP that opened its own RedDB in the session
// process: N sessions on one machine meant N open handles on one store, and a
// second checkout meant a second brain entirely. ADR 0152 moved both problems
// here — the store is the USER's, it lives at `~/.red/brain`, and the daemon
// holds it once per host.
//
// The memo below is the whole decision made mechanical. Two sessions that call
// concurrently share one open, because the PROMISE is cached rather than the
// handle: caching the handle would let the second caller start a second open
// while the first was still in flight, which is exactly the N-handles shape
// this replaced. A failed open drops the memo so a transient failure does not
// poison the host until the daemon restarts.
import { RequestError } from "@agentclientprotocol/sdk";
import {
  resolveHostBrainConfig,
  type ResolvedBrainConfig,
} from "@reddb-io/brain-store/config.js";
import { BrainStore, type BrainStoreLike } from "@reddb-io/brain-store/store.js";
import { brainAct } from "@reddb-io/brain-store/brain-act.js";
import type {
  RedskilledBrainAnswer,
  RedskilledBrainCall,
  RedskilledBrainTool,
} from "@reddb-io/protocol-acp";

/** The store the daemon opened, and where it opened it. */
export interface OpenedHostBrain {
  readonly config: ResolvedBrainConfig;
  readonly store: BrainStoreLike;
}

export interface HostBrainStoreDeps {
  /** Where HOME is. Production reads the daemon process's own environment. */
  readonly env?: Record<string, string | undefined>;
  /** Test seam; production opens the RedDB behind the resolved config. */
  readonly open?: (config: ResolvedBrainConfig) => Promise<BrainStoreLike>;
  /** Test seam; production reaches the outbound channel bridge. */
  readonly act?: (input: { target: string; message: string }) => Promise<unknown>;
}

/** The handle every ACP connection on this host shares. */
export interface HostBrainStore {
  /** Serve one brain tool call from the host store, opening it on first use. */
  call(call: RedskilledBrainCall): Promise<RedskilledBrainAnswer>;
  /** Close the held store, if one was ever opened. */
  close(): Promise<void>;
}

/**
 * Create the host's brain holder. Call this ONCE per daemon, never per
 * connection — a holder per connection is a handle per session wearing a
 * different name.
 */
export function createHostBrainStore(deps: HostBrainStoreDeps = {}): HostBrainStore {
  const openStore = deps.open ?? openRedDbBrainStore;
  const act = deps.act ?? ((input: { target: string; message: string }) => brainAct(input));
  let held: Promise<OpenedHostBrain> | undefined;

  const opened = (): Promise<OpenedHostBrain> => {
    held ??= (async () => {
      const config = await resolveHostBrainConfig(deps.env ?? process.env);
      return { config, store: await openStore(config) };
    })().catch((error: unknown) => {
      held = undefined;
      throw error;
    });
    return held;
  };

  return {
    async call(call) {
      const brain = await opened();
      return {
        tool: call.tool,
        root: brain.config.rootDir,
        result: await serveBrainTool(brain, call, act),
      };
    },
    async close() {
      const pending = held;
      if (pending == null) return;
      held = undefined;
      await (await pending).store.close();
    },
  };
}

async function openRedDbBrainStore(config: ResolvedBrainConfig): Promise<BrainStoreLike> {
  return await BrainStore.open({ uri: config.connectionString });
}

/**
 * Dispatch one tool against the held store.
 *
 * Every argument is re-read here rather than trusted: the adapter publishes
 * schemas an MCP host validates, but the adapter is not the only thing that can
 * reach this socket, and a store that takes an unchecked shape from the wire is
 * a store any ACP peer can corrupt.
 */
async function serveBrainTool(
  brain: OpenedHostBrain,
  call: RedskilledBrainCall,
  act: (input: { target: string; message: string }) => Promise<unknown>,
): Promise<unknown> {
  const args = call.arguments;
  const store = brain.store;
  switch (call.tool) {
    case "brain_init":
    case "brain_status":
      return {
        rootDir: brain.config.rootDir,
        configPath: brain.config.configPath,
        ...(await store.status()),
      };
    case "brain_capture":
      return await store.capture({
        title: text(call.tool, args, "title"),
        content: text(call.tool, args, "content"),
        kind: optionalText(call.tool, args, "kind") ?? "note",
        tags: textList(call.tool, args, "tags"),
        ...optional("sourceAgent", optionalText(call.tool, args, "source_agent")),
        ...optional("sourceSession", optionalText(call.tool, args, "source_session")),
        ...optional("sourcePath", optionalText(call.tool, args, "source_path")),
        ...optional("metadata", record(call.tool, args, "metadata")),
      });
    case "brain_search":
      return await store.search(text(call.tool, args, "query"), limit(call.tool, args));
    case "brain_think":
      return await store.think(text(call.tool, args, "query"), limit(call.tool, args));
    case "brain_get":
      return await store.getArtifact(identifier(call.tool, args, "id"));
    case "brain_link":
      return await store.link({
        from: identifier(call.tool, args, "from"),
        to: identifier(call.tool, args, "to"),
        kind: optionalText(call.tool, args, "kind") ?? "related_to",
        ...optional("reason", optionalText(call.tool, args, "reason")),
      });
    case "brain_backlinks":
      return await store.backlinks(identifier(call.tool, args, "id"));
    case "brain_act":
      return await act({
        target: text(call.tool, args, "target"),
        message: text(call.tool, args, "message"),
      });
    case "brain_kpis":
      return await store.eventKpis({
        interval: (optionalText(call.tool, args, "interval") ?? "day") as "hour" | "day" | "week" | "month",
        ...optional("groupBy", optionalText(call.tool, args, "group_by")),
        timeField: (optionalText(call.tool, args, "time_field") ?? "event") as "event" | "ingested",
        ...optional("from", args.from),
        ...optional("to", args.to),
        ...optional("platform", optionalText(call.tool, args, "platform")),
        ...optional("eventType", optionalText(call.tool, args, "event_type")),
        ...optional("target", optionalText(call.tool, args, "target")),
      } as Parameters<BrainStoreLike["eventKpis"]>[0]);
  }
}

/** Spread a key only when it has a value; an explicit `undefined` is not one. */
function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function text(tool: RedskilledBrainTool, args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw RequestError.invalidParams({}, `${tool} needs a non-empty ${key}`);
  }
  return value;
}

function optionalText(
  tool: RedskilledBrainTool,
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw RequestError.invalidParams({}, `${tool}: ${key} must be a string`);
  return value;
}

function textList(
  tool: RedskilledBrainTool,
  args: Readonly<Record<string, unknown>>,
  key: string,
): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw RequestError.invalidParams({}, `${tool}: ${key} must be a list of strings`);
  }
  return value as string[];
}

function record(
  tool: RedskilledBrainTool,
  args: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams({}, `${tool}: ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** An artifact is addressed by its rid or its id; both spellings are ordinary. */
function identifier(
  tool: RedskilledBrainTool,
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") return value;
  throw RequestError.invalidParams({}, `${tool} needs an artifact rid or id as ${key}`);
}

/** How many hits to return. Bounded here because the store will honour any number. */
function limit(tool: RedskilledBrainTool, args: Readonly<Record<string, unknown>>): number {
  const value = args.limit;
  if (value === undefined || value === null) return 10;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw RequestError.invalidParams({}, `${tool}: limit must be an integer between 1 and 50`);
  }
  return value;
}
