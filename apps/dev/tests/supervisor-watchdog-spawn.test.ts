import { mkdtemp, rm } from "node:fs/promises";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn((
  _command: string,
  _args: readonly string[],
  _options: SpawnOptions,
) => ({ unref: vi.fn() })));
const readFile = vi.hoisted(() => vi.fn(async () => {
  throw new Error("missing");
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile,
}));

import { spawnSupervisorWatchdog } from "../src/runtime/supervisor-watchdog-spawn.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  spawn.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "supervisor-watchdog-spawn-"));
  roots.push(value);
  return value;
}

describe("spawnSupervisorWatchdog — MCP-context path resolution (Refs #2630)", () => {
  it("resolves the sibling dev bundle when argv[1] is the castle-mcp bundle (MCP context)", async () => {
    const cwd = await root();
    vi.useFakeTimers();
    const saved = process.argv[1];
    process.argv[1] = join("dist", "castle-mcp.bundle.min.mjs");
    try {
      const promise = spawnSupervisorWatchdog({ root: cwd });
      await vi.advanceTimersByTimeAsync(4_000);
      await promise;
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("dist", "dev.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
  });

  it("resolves the sibling dev bundle when argv[1] is a versioned castle-mcp bundle (MCP context)", async () => {
    const cwd = await root();
    vi.useFakeTimers();
    const saved = process.argv[1];
    process.argv[1] = join("/npx-cache", "castle-mcp-2.76.1.bundle.min.mjs");
    try {
      const promise = spawnSupervisorWatchdog({ root: cwd });
      await vi.advanceTimersByTimeAsync(4_000);
      await promise;
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("/npx-cache", "dev-2.76.1.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
  });

  it("passes argv[1] through unchanged when already the dev bundle (CLI context)", async () => {
    const cwd = await root();
    vi.useFakeTimers();
    const saved = process.argv[1];
    process.argv[1] = join("/npx-cache", "dev-2.76.1.bundle.min.mjs");
    try {
      const promise = spawnSupervisorWatchdog({ root: cwd });
      await vi.advanceTimersByTimeAsync(4_000);
      await promise;
      const args = spawn.mock.calls.at(-1)?.[1] as string[] | undefined;
      expect(args?.[0]).toBe(join("/npx-cache", "dev-2.76.1.bundle.min.mjs"));
    } finally {
      process.argv[1] = saved;
    }
  });
});
