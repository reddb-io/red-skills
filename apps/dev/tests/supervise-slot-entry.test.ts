// Slot spawn argv — the worker entry must never be inferred from argv[1]
// (#2677). Under the MCP lane the supervisor IS the castle-mcp bundle, whose
// entry does not route `run`; spawning slots against it made every slot die on
// a singleton-lease error and the fleet drain nothing.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() =>
  vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => ({
    on: vi.fn(),
    unref: vi.fn(),
    pid: 4242,
  })),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

import { buildSupervisorDeps } from "../src/commands/supervise.js";
import { parseCli } from "../src/cli.js";
import { main as mcpMain } from "../src/mcp-server.js";

const roots: string[] = [];

afterEach(async () => {
  spawn.mockClear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "supervise-slot-entry-"));
  roots.push(value);
  await mkdir(join(value, ".red", "tmp", "slot-logs"), { recursive: true });
  return value;
}

async function deps(cwd: string) {
  return buildSupervisorDeps(
    cwd,
    join(cwd, ".red", "tmp"),
    join(cwd, ".red", "tmp", "slot-logs"),
    join(cwd, ".red", "tmp", "firehose.toonl"),
    join(cwd, ".red", "tmp", "state.toon"),
    "s1234",
    "default",
    "claude",
    300,
    { cwd, repo: "reddb-io/red-skills" },
    "main",
    [],
    {},
  );
}

/** argv[1] shapes a supervisor can be re-exec'd under. */
const MCP_BUNDLE = "/opt/red/dist/castle-mcp.bundle.min.mjs";
const VERSIONED_MCP_BUNDLE = "/opt/red/dist/castle-mcp-2.90.0.bundle.min.mjs";

describe("spawnSlot worker entry (#2677)", () => {
  it("spawns the dev bundle — not the castle-mcp bundle — when the supervisor is the MCP entry", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, MCP_BUNDLE, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);

    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0]![1] as readonly string[];
    expect(basename(args[0]!)).toBe("dev.bundle.min.mjs");
    expect(args).not.toContain(MCP_BUNDLE);
    expect(args.slice(1, 3)).toEqual(["run", "--once"]);
  });

  it("resolves the versioned dev sibling for a versioned castle-mcp bundle", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([
      process.execPath,
      VERSIONED_MCP_BUNDLE,
      "__supervise",
    ]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);

    expect(basename((spawn.mock.calls[0]![1] as readonly string[])[0]!)).toBe(
      "dev-2.90.0.bundle.min.mjs",
    );
  });

  it("leaves the CLI lane untouched — a dev bundle argv[1] is spawned unchanged", async () => {
    const cwd = await root();
    const devBundle = "/opt/red/dist/dev.bundle.min.mjs";
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, devBundle, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);

    expect((spawn.mock.calls[0]![1] as readonly string[])[0]).toBe(devBundle);
  });

  it("spawns the dev bundle for reconcile workers too", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, MCP_BUNDLE, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnReconcileWorker?.(1, { issue: 42 } as never);

    const args = spawn.mock.calls[0]![1] as readonly string[];
    expect(basename(args[0]!)).toBe("dev.bundle.min.mjs");
    expect(args).toContain("--reconcile-issue");
  });
});

describe("MCP-launched fleet regression: the slot boots a worker instead of dying (#2677)", () => {
  it("routes the produced slot argv through the dev entry as `run` (never the mcp entry)", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, MCP_BUNDLE, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);
    const [entry, ...slotArgv] = spawn.mock.calls[0]![1] as readonly string[];

    // The entry is the one that routes `run` — a real worker boots and writes
    // its worker directory, so the slot occupies its slot instead of dying.
    expect(basename(entry!)).toBe("dev.bundle.min.mjs");
    expect(parseCli(slotArgv).command).toBe("run");

    // And the pre-fix target can no longer swallow the same argv silently: the
    // castle-mcp entry refuses it by name rather than opening a second resident.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(
      mcpMain(slotArgv, {
        supervise: async () => 0,
        startCurator: async () => expect.unreachable("curator must not start for `run`"),
        startMergeDriver: async () => expect.unreachable("merge driver must not start for `run`"),
        connect: async () => expect.unreachable("stdio transport must not open for `run`"),
      }),
    ).resolves.toBe(2);
    expect(stderr.mock.calls[0]![0]).toContain("unroutable subcommand");
  });
});
