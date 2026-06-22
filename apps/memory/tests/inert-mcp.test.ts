import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// Issue #843: a gated-off `mcp` invocation must complete the MCP handshake with
// an empty tool list and stay alive, not close the pipe (which the host reports
// as `✘ Failed to connect` / "1 error during load").

const BOOTSTRAP = resolve(__dirname, "../../../plugins/memory/scripts/bootstrap.mjs");
const TIMEOUT = 20_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gatedOffDir(): Promise<string> {
  // A temp dir under the OS tmpdir has no `.red/config.yaml` in any ancestor, so
  // the per-directory gate (ADR 0067) treats memory as disabled.
  const root = await mkdtemp(join(tmpdir(), "memory-inert-mcp-"));
  roots.push(root);
  return root;
}

describe("gated-off mcp path (issue #843)", () => {
  test(
    "completes initialize + tools/list with zero tools and stays alive",
    async () => {
      const cwd = await gatedOffDir();
      const child = spawn(process.execPath, [BOOTSTRAP, "mcp"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const responses: Array<Record<string, unknown>> = [];
      let buffer = "";
      const seen = new Promise<void>((resolveSeen) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            responses.push(JSON.parse(line));
            if (responses.length >= 2) resolveSeen();
          }
        });
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);

      await seen;

      const init = responses.find((r) => r.id === 1) as { result: { capabilities: Record<string, unknown>; serverInfo: { name: string } } };
      const list = responses.find((r) => r.id === 2) as { result: { tools: unknown[] } };
      expect(init.result.capabilities).toHaveProperty("tools");
      expect(init.result.serverInfo.name).toBe("red-memory");
      expect(list.result.tools).toEqual([]);

      // Still alive — it did not close the pipe / exit on its own.
      expect(child.exitCode).toBeNull();

      child.kill();
    },
    TIMEOUT,
  );
});
