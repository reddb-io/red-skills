// rsp-wait-launch — the one process the MCP surface still starts itself.
//
// An `rsp wait` is NOT a Worker: it claims no ticket, runs no runner, spends no
// host budget and dies when the thing it watches resolves. The daemon owns Worker
// birth (ADR 0130), and this is deliberately outside that authority.
//
// It lives in its own module because `mcp-adapter.ts` is now a declared
// `host-owns-birth` site (#2976), and that ratchet reads a MODULE rather than a
// call: a file that may not birth a Worker must hold no way to create a process
// at all, because "this particular spawn is fine" is exactly the judgement a
// ratchet exists to stop making. Keeping the wait's spawn here states the
// distinction structurally instead of asking a reader to re-litigate it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The rsp bundle shipped beside the MCP bundle this process is running.
 *
 * In MCP context `process.argv[1]` is the castle-mcp bundle, which routes no
 * `wait` subcommand; its sibling does.
 */
export function resolveRspCliBundle(mcpBundle: string): string {
  const file = basename(mcpBundle);
  if (file === "castle-mcp.bundle.min.mjs") {
    return join(dirname(mcpBundle), "rsp.bundle.min.mjs");
  }
  if (file.startsWith("castle-mcp-") && file.endsWith(".bundle.min.mjs")) {
    return join(dirname(mcpBundle), file.replace(/^castle-mcp-/, "rsp-"));
  }
  throw new Error(
    `cannot spawn rsp wait: unrecognized MCP bundle name ${JSON.stringify(file)}`,
  );
}

/** Start a detached `rsp wait`; returns the child PID. */
export async function launchDetachedRspWait(
  args: readonly string[],
  cwd: string,
): Promise<number> {
  const mcpBundle = process.argv[1];
  if (!mcpBundle) {
    throw new Error("cannot spawn rsp wait: MCP bundle path is missing");
  }
  const bundle = resolveRspCliBundle(mcpBundle);
  if (!existsSync(bundle)) {
    throw new Error("cannot spawn rsp wait: sibling rsp bundle is missing");
  }
  const child = spawn(process.execPath, [bundle, ...args], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (!pid) throw new Error("cannot spawn rsp wait: spawn returned no pid");
  child.unref();
  return pid;
}
