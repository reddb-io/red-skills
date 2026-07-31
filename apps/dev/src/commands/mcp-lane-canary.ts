// `castle-mcp __mcp-canary` — run the MCP lane canary against a bundle.
//
// Internal by design (the `__` prefix): this is a probe CI and operators fire
// deliberately, not a queue surface. It really REGISTERS this project through
// the canonical MCP interface and gives the registration back again, because
// that round trip against a live daemon is the only thing that proves the lane
// is not inert (#2677, #2902, ADR 0128 §7).
//
// It is routed from the castle-mcp entry rather than the dev CLI: the canary
// needs the MCP CLIENT SDK, whose bundled ajv leaves bare `require()` calls
// that the dev bundle contract forbids.

import { resolve } from "node:path";
import {
  renderMcpLaneCanaryToon,
  runMcpLaneCanary,
  type McpLaneCanaryResult,
} from "../core/mcp-lane-canary.js";
import {
  connectMcpLaneCanary,
  resolveCanarySocketPath,
  resolveShippedMcpEntry,
} from "../runtime/mcp-lane-canary-io.js";

interface McpLaneCanaryIO {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface ParsedMcpLaneCanaryArgs {
  /** MCP server bundle entry the canary launches. */
  entry: string;
  root: string;
  runner: string;
  target: number;
  quietDeadlineMs: number;
  teardownDeadlineMs: number;
}

const USAGE = `Usage: castle-mcp __mcp-canary [options]

Drives the shipped MCP lane end to end — project_start -> a registration the
daemon holds -> no process of the project's own -> project_status -> project_stop
— and fails loudly naming the step that went inert.

  --entry <path>              MCP bundle entry (default: the castle-mcp bundle
                              beside this process's own entry)
  --root <dir>                repo the canary starts its worker in (default: cwd)
  --runner <runner>           runner for the canary worker (default: claude)
  --quiet-deadline-ms <n>     how long the probe watches for a process the
                              project must never have started (default: 3000)
  --teardown-deadline-ms <n>  how long project_stop may take (default: 20000)
`;

export function parseMcpLaneCanaryArgs(
  args: readonly string[],
  cwd = process.cwd(),
): ParsedMcpLaneCanaryArgs {
  const parsed: ParsedMcpLaneCanaryArgs = {
    entry: resolveShippedMcpEntry(process.argv[1] ?? ""),
    root: cwd,
    runner: "claude",
    target: 1,
    quietDeadlineMs: 3_000,
    teardownDeadlineMs: 20_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    const require = (): string => {
      if (value === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--entry":
        parsed.entry = resolve(cwd, require());
        break;
      case "--root":
        parsed.root = resolve(cwd, require());
        break;
      case "--runner":
        parsed.runner = require();
        break;
      case "--quiet-deadline-ms":
        parsed.quietDeadlineMs = positiveInteger(flag, require());
        break;
      case "--teardown-deadline-ms":
        parsed.teardownDeadlineMs = positiveInteger(flag, require());
        break;
      default:
        throw new Error(`unknown flag: ${String(flag)}`);
    }
  }
  return parsed;
}

function positiveInteger(flag: string | undefined, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${String(flag)} requires a positive integer, got ${raw}`);
  }
  return value;
}

/** Run one canary walk against `parsed.entry`, returning the walk itself so a
 * caller can report it however it likes. */
export async function runMcpLaneCanaryAgainstEntry(
  parsed: ParsedMcpLaneCanaryArgs,
): Promise<{ result: McpLaneCanaryResult; stderr: string }> {
  const socketPath = await resolveCanarySocketPath();
  const transport = await connectMcpLaneCanary({
    args: [parsed.entry],
    cwd: parsed.root,
  });
  try {
    const result = await runMcpLaneCanary(transport, {
      runner: parsed.runner,
      target: parsed.target,
      quietDeadlineMs: parsed.quietDeadlineMs,
      teardownDeadlineMs: parsed.teardownDeadlineMs,
      ...(socketPath !== undefined ? { socketPath } : {}),
    });
    return { result, stderr: transport.stderr() };
  } finally {
    await transport.close();
  }
}

export async function mcpLaneCanaryCommand(
  args: readonly string[],
  io: McpLaneCanaryIO = { stdout: process.stdout, stderr: process.stderr },
  cwd = process.cwd(),
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout.write(USAGE);
    return 0;
  }
  let parsed: ParsedMcpLaneCanaryArgs;
  try {
    parsed = parseMcpLaneCanaryArgs(args, cwd);
  } catch (error) {
    io.stderr.write(`[mcp-canary] ${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr.write(USAGE);
    return 2;
  }

  let walk: { result: McpLaneCanaryResult; stderr: string };
  try {
    walk = await runMcpLaneCanaryAgainstEntry(parsed);
  } catch (error) {
    // A transport that never opened is itself the `connect` step going inert;
    // report it in the canary's own vocabulary rather than as a stack trace.
    io.stderr.write(
      `[mcp-canary] connect went inert: could not open an MCP session against ${parsed.entry}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  io.stdout.write(`${renderMcpLaneCanaryToon(walk.result)}\n`);
  if (walk.result.ok) return 0;
  io.stderr.write(`[mcp-canary] ${walk.result.summary}\n`);
  if (walk.stderr.trim() !== "") {
    io.stderr.write(`[mcp-canary] server stderr tail:\n${walk.stderr.trimEnd()}\n`);
  }
  return 1;
}
