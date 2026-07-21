import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendCastleLaneRecord,
  castleLanePath,
  createEnginePaths,
  fleetRegistryPath,
  upsertFleetProfile,
} from "@reddb-io/red-castle/engine";
import {
  createDefaultDevAfkMcpSensitiveOperations,
  createDevAfkMcpDependencies,
  type DevAfkMcpSensitiveOperations,
} from "../src/mcp-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dev-afk-mcp-"));
  roots.push(value);
  return value;
}

describe("dev:afk MCP host adapter", () => {
  it("lists registered fleets through the Castle registry primitive", async () => {
    const cwd = await root();
    const paths = createEnginePaths(join(cwd, ".red"));
    await upsertFleetProfile(fleetRegistryPath(paths), {
      name: "codex",
      runner: "codex",
      selector: { spec: 2303 },
    });

    await expect(createDevAfkMcpDependencies(cwd).fleetList()).resolves.toEqual(
      [
        {
          name: "codex",
          runner: "codex",
          selector: { spec: 2303 },
        },
      ],
    );
  });

  it("returns raw CastleLaneRecord entries and rejects lane-root escapes", async () => {
    const cwd = await root();
    const paths = createEnginePaths(join(cwd, ".red"));
    await appendCastleLaneRecord(castleLanePath(paths, "worker", "worker-1"), {
      at: "2026-07-21T00:00:00.000Z",
      kind: "worker.started",
      issue: 2305,
      payload: { runner: "codex" },
    });
    const deps = createDevAfkMcpDependencies(cwd);

    await expect(
      deps.logs({ lane: "worker", id: "worker-1" }),
    ).resolves.toEqual([
      {
        at: "2026-07-21T00:00:00.000Z",
        kind: "worker.started",
        issue: 2305,
        payload: { runner: "codex" },
      },
    ]);
    await expect(
      deps.logs({ lane: "worker", id: "../../outside" }),
    ).rejects.toThrow("escapes its Castle lane root");
  });

  it("delegates gate and landing to the sensitive engine operations", async () => {
    const cwd = await root();
    const operations: DevAfkMcpSensitiveOperations = {
      gateRun: async () => ({ ok: true, checks: [] }),
      gateBaselineStatus: async () => ({ red: false, issue: null }),
      landBranch: async (input) => ({ ok: true, branch: input.branch }),
      cascadeStatus: async () => [],
      claimStatus: async () => [],
      claimRelease: async () => ({ released: true }),
      worktreeList: async () => [],
      worktreeRemove: async () => ({ removed: true }),
    };
    const deps = createDevAfkMcpDependencies(cwd, operations);

    await expect(
      deps.gateRun({ branch: "afk/wAAAA/2307-tools", base: "main" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      deps.landBranch({
        issue: 2307,
        title: "Sensitive tools",
        branch: "afk/wAAAA/2307-tools",
        base: "main",
        gatePassed: true,
      }),
    ).resolves.toMatchObject({ branch: "afk/wAAAA/2307-tools" });
  });

  it("enumerates canonical worktree lanes and rejects removal path escapes", async () => {
    const cwd = await root();
    await mkdir(join(cwd, ".red", "tmp", "worktrees", "landing", "main-0"), {
      recursive: true,
    });
    const operations = createDefaultDevAfkMcpSensitiveOperations(cwd);

    await expect(operations.worktreeList()).resolves.toEqual([
      expect.objectContaining({ lane: "landing", name: "main-0" }),
    ]);
    await expect(
      operations.worktreeRemove({ worktree: "../../outside" }),
    ).rejects.toThrow("canonical worktree lane");
  });
});
