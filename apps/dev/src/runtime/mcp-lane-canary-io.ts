// mcp-lane-canary-io — the real transport behind the canary walk.
//
// The canary is only worth its name when it speaks the SAME protocol an agent
// speaks: a child process launched from a bundle entry, an MCP stdio handshake,
// and `tools/call`. An in-process core call would have stayed green through the
// whole of #2677, because the defect lived in what the shipped bundle spawns,
// not in what the core function returns.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { decode } from "@reddb-io/toon";
import type { CanaryWorker, McpLaneCanaryDeps } from "../core/mcp-lane-canary.js";
import { workersSegment } from "../core/worker-paths.js";
import { afkPaths } from "./wire.js";

/** How the canary reaches the MCP server under test. Defaults to the shipped
 * castle-mcp bundle beside this process's own entry. */
export interface McpLaneCanaryTarget {
  /** Executable to launch. Defaults to this process's node. */
  readonly command?: string;
  /** Argv for it — the FIRST entry is the bundle whose lane is under test. */
  readonly args: readonly string[];
  /** Working directory the fleet is created in. */
  readonly cwd: string;
  readonly env?: Record<string, string>;
}

export interface McpLaneCanaryTransport extends McpLaneCanaryDeps {
  close(): Promise<void>;
  /** Whatever the server wrote to stderr, for a failure report. */
  stderr(): string;
}

export function isLivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — still live.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Scan the worker lane the way every other reader does: a directory per worker
 * holding the `worker.pid` liveness anchor (ADR 0128 §5). A missing lane reads
 * as zero workers, never an error — "no worker directory" IS the finding the
 * canary is looking for.
 */
export async function observeWorkersOnDisk(root: string): Promise<readonly CanaryWorker[]> {
  const workersRoot = join(afkPaths(root).tmpDir, workersSegment());
  let entries: string[];
  try {
    entries = (await readdir(workersRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.map((worker) => {
    const dir = join(workersRoot, worker);
    let pid: number | null = null;
    try {
      const parsed = Number(readFileSync(join(dir, "worker.pid"), "utf8").trim());
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      pid = null;
    }
    return { worker, dir, pid, alive: pid !== null && isLivePid(pid) };
  });
}

/** Decode one `tools/call` result. Castle tools answer TOON text (ADR 0097);
 * a server that answers JSON still decodes, so the canary never fails on
 * encoding when the lane itself is healthy. */
export function decodeToolPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return {};
  try {
    return decode(trimmed);
  } catch {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return { text: trimmed };
    }
  }
}

/**
 * Resolve the shipped castle-mcp bundle to canary. The whole point is to run
 * against the SHIPPED artifact, so the default target is the running bundle
 * itself (the canary ships inside castle-mcp) or its castle-mcp sibling when
 * invoked from the dev entry — never a source file.
 */
export function resolveShippedMcpEntry(argv1: string): string {
  const dir = dirname(argv1);
  const file = argv1.slice(dir.length + 1);
  if (file.startsWith("castle-mcp")) return argv1;
  const versioned = file.match(/^dev-(.+)\.bundle\.min\.mjs$/);
  if (versioned) return join(dir, `castle-mcp-${versioned[1]}.bundle.min.mjs`);
  return join(dir, "castle-mcp.bundle.min.mjs");
}

/**
 * The session socket the lane under test must cross, resolved exactly the way
 * the lane resolves it (same env, same session key) so the two cannot name two
 * different sockets.
 *
 * An unresolvable path returns undefined rather than throwing: a canary that
 * cannot state the path must still run and still say the hop broke — the walk
 * reports "path unresolved", which is itself an operator-routing fact.
 */
export async function resolveCanarySocketPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const { resolveRedskilledPaths } = await import("@reddb-io/redskilled/paths");
    return resolveRedskilledPaths({ env }).socketPath;
  } catch {
    return undefined;
  }
}

/**
 * Open a real MCP stdio session against `target` and return the canary's deps.
 * The caller owns `close()` — a canary that leaks its server child is one more
 * inert process on the host.
 */
export async function connectMcpLaneCanary(
  target: McpLaneCanaryTarget,
): Promise<McpLaneCanaryTransport> {
  const transport = new StdioClientTransport({
    command: target.command ?? process.execPath,
    args: [...target.args],
    cwd: target.cwd,
    env: target.env ?? (process.env as Record<string, string>),
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-lane-canary", version: "1" }, { capabilities: {} });
  let stderrText = "";
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    // Bounded: a runaway server must not turn a canary report into a log dump.
    stderrText = `${stderrText}${chunk.toString("utf8")}`.slice(-8_000);
  });

  return {
    listTools: async () => (await client.listTools()).tools.map((tool) => tool.name),
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
      if (result.isError === true) {
        throw new Error(`${name} returned an error result: ${renderContent(result.content)}`);
      }
      return decodeToolPayload(renderContent(result.content));
    },
    observeWorkers: () => observeWorkersOnDisk(target.cwd),
    isLive: isLivePid,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    stderr: () => stderrText,
    close: async () => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const shaped = part as { type?: string; text?: string };
      return shaped.type === "text" ? (shaped.text ?? "") : "";
    })
    .join("");
}
