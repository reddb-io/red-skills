// The MCP registers its project instead of launching a process (#2902, ADR 0130
// Amendment 4). Two players, and the project is not one of the processes: the
// session's MCP states a repository identity, an opaque selector, an opaque argv
// and a target, and the daemon holds them. Beginning work creates no process of
// the project's own.
//
// The daemon under test is the real one on a scratch session socket. A mock would
// answer whatever the assertion wanted, and the fact worth proving here is
// precisely that a registration reached a second process — and that nothing was
// spawned to reach it.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn((
  _command: string,
  _args: readonly string[],
  _options: SpawnOptions,
) => ({ unref: vi.fn() })));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

// The port is the REAL one; only where it reaches is injected, so these cases
// speak to a daemon of their own instead of to whichever one the developer's
// machine happens to be running.
const host = vi.hoisted(() => ({
  paths: undefined as unknown,
  config: undefined as unknown,
}));

vi.mock("../src/runtime/redskilled-birth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/redskilled-birth.js")>();
  return {
    ...actual,
    createRedskilledBirthPort: (options: Parameters<typeof actual.createRedskilledBirthPort>[0]) =>
      actual.createRedskilledBirthPort({
        ...options,
        ...(host.paths ? { paths: host.paths as never } : {}),
        ...(host.config ? { config: host.config as never } : {}),
      }),
  };
});

import { startRedskilledDaemon, type RedskilledDaemon } from "@reddb-io/redskilled/daemon";
import { resolveRedskilledPaths, type RedskilledPaths } from "@reddb-io/redskilled/paths";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  host.paths = undefined;
  host.config = undefined;
  spawn.mockClear();
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("dev-register-session-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A checkout with the plugin enabled — the project the MCP speaks for. */
async function project(): Promise<string> {
  const root = await scratch("dev-register-project-");
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(
    join(root, ".red", "config.yaml"),
    "plugins:\n  dev:\n    enabled: true\n",
    "utf8",
  );
  return root;
}

/** The daemon this session reaches, already answering. */
async function liveHost(): Promise<RedskilledDaemon> {
  const paths = await sessionPaths();
  const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
  running.push(daemon);
  host.paths = paths;
  return daemon;
}

describe("starting work registers the project", () => {
  it("hands the daemon a registration and starts no process of the project's own", async () => {
    const daemon = await liveHost();
    const root = await project();

    const started = await createCastleMcpDependencies(root).projectStart({
      runner: "claude",
      target: 3,
    }) as Record<string, unknown>;

    expect(started.status).toBe("registered");
    expect(started.target).toBe(3);

    const held = daemon.registrations();
    expect(held).toHaveLength(1);
    expect(held[0]!.target).toBe(3);
    expect(held[0]!.project_label).toBe(started.project);

    // The whole point of the slice: no detached per-project process was launched.
    expect(spawn.mock.calls.filter((call) => (call[1] ?? []).includes("__supervise"))).toEqual([]);
  });

  it("carries the project's selector and argv unmodified", async () => {
    const daemon = await liveHost();
    const root = await project();

    const started = await createCastleMcpDependencies(root).projectStart({
      runner: "codex",
      target: 2,
      selector: { lane: "go", issues: [2902] },
    }) as Record<string, unknown>;

    const held = daemon.registrations()[0]!;
    // What the client stated is what the daemon holds — byte for byte, both
    // strings, because the daemon never read either of them.
    expect(held.selector).toBe(started.selector);
    expect(held.argv).toEqual(started.argv);
    expect(held.selector).toContain("2902");
    expect(held.selector).toContain("go");
    // The argv is what runs when a Worker is born for this project, so it carries
    // the runner the operator chose and the same selector the registration does.
    expect(held.argv).toContain("--runner");
    expect(held.argv).toContain("codex");
    expect(held.argv.join(" ")).toContain("2902");
  });

  it("refuses with the socket named when no daemon answers, rather than launching", async () => {
    const root = await project();
    const unreachable = await scratch("dev-register-silent-");
    host.paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${unreachable}`, REDSKILLED_MACHINE_DIR: unreachable },
      runtimeDir: unreachable,
    });
    // No published bundle to auto-spawn from, and none invented: fail closed.
    host.config = { entryLookup: {}, readyTimeoutMs: 250 };

    const socketPath = (host.paths as RedskilledPaths).socketPath;
    await expect(
      createCastleMcpDependencies(root).projectStart({ runner: "claude", target: 1 }),
    ).rejects.toThrow(socketPath);

    // Fail closed (ADR 0130 rule 6): a refused registration falls back to nothing.
    expect(spawn.mock.calls.filter((call) => (call[1] ?? []).includes("__supervise"))).toEqual([]);
  });
});

describe("stopping work deregisters the project", () => {
  it("gives the registration back, so the project can register again", async () => {
    const daemon = await liveHost();
    const root = await project();
    const deps = createCastleMcpDependencies(root);

    await deps.projectStart({ runner: "claude", target: 1 });
    expect(daemon.registrations()).toHaveLength(1);

    const stopped = await deps.projectStop({}) as Record<string, unknown>;
    expect(stopped.deregistered).toBe(true);
    expect(daemon.registrations()).toEqual([]);

    // A project whose registration was given back is a project that may take one
    // again — the duplicate refusal must not outlive the record it named.
    await expect(deps.projectStart({ runner: "claude", target: 2 })).resolves.toMatchObject({
      status: "registered",
      target: 2,
    });
  });
});
