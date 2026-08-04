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
import { execFileSync, type SpawnOptions } from "node:child_process";
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

/**
 * A checkout with the plugin enabled — the project the MCP speaks for.
 *
 * A real checkout with a real `origin`, because a registration names the TRACKER
 * its queue lives in (#2974): the daemon polls the query it is handed, so a
 * project that stated no repository would hand the host a question about every
 * repository the token can see.
 */
async function project(): Promise<string> {
  const root = await scratch("dev-register-project-");
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(
    join(root, ".red", "config.yaml"),
    "plugins:\n  dev:\n    enabled: true\n",
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
    cwd: root,
    stdio: "ignore",
  });
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
    // The selector the HOST holds is a tracker query, because the host hands it
    // to the tracker (#2974): the repository it counts in, the executable queue
    // it counts, and every facet a query can carry. The issue-number facet is
    // not one of them — search cannot filter on it — so it travels in the argv
    // to the Worker, which is the reader that can act on it.
    expect(held.selector).toBe(
      'repo:acme/widgets is:issue is:open label:"ready-for-agent" label:"lane:go"',
    );
    expect(held.queue_poll).toEqual({
      owner: "acme",
      repo: "widgets",
      labels: ["ready-for-agent", "lane:go"],
    });
    expect(started.warnings).toEqual([expect.stringContaining("issues")]);
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

  it("refuses a checkout with no `origin`, rather than registering a query about everything", async () => {
    // The second refusal, against a daemon that DOES answer, so the reason is
    // the checkout rather than the host. It lived as an alternation in the
    // adapter suite's daemon-down case until #2981 pinned that host: which of
    // the two refusals fired there depended on whether the developer's machine
    // ran a daemon, which is no way to pin either of them.
    await liveHost();
    const root = await scratch("dev-register-untracked-");
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });

    await expect(
      createCastleMcpDependencies(root).projectStart({ runner: "claude", target: 1 }),
    ).rejects.toThrow(/no `origin` remote/);
  });

  it("reports when and why this project's registration lapsed", async () => {
    const daemon = await liveHost();
    const root = await project();
    daemon.registerProject({
      project_label: "acme/widgets",
      selector: 'repo:acme/widgets is:issue is:open label:"ready-for-agent"',
      argv: ["red-skills-dev", "run", "--once"],
      workspace_path: root,
      target: 1,
      renew_within_ms: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Observe the deadline on the daemon before asking the project surface.
    expect(daemon.hostState().registrations).toEqual([]);

    const status = await createCastleMcpDependencies(root).projectStatus();
    expect(status.registration).toMatchObject({
      held: false,
      daemon_reachable: true,
      lapsed_at: expect.stringMatching(/^2026-|^20\d\d-/),
      reason: expect.stringContaining("nothing renewed it"),
    });
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
