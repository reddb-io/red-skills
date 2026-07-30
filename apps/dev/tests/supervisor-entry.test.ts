import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

import { spawnSupervisor, stampFreshFleetHeartbeat } from "../src/runtime/supervisor-spawn.js";
import {
  PUBLISHED_VERSION_UNRESOLVED,
  SUPERVISOR_ENTRY_UNRESOLVED,
  SupervisorEntryError,
  resolveSupervisorEntry,
  supervisorLaunchVersion,
  type SupervisorEntryLookup,
} from "../src/runtime/supervisor-entry.js";
import { resolvePublishedDevBundleVersion } from "../src/core/bundle-version.js";
import { runFleetTruthProbe } from "../src/core/operational-probes/fleet-truth.js";
import { decodeDevSnapshotSniff } from "../src/core/toon-snapshot.js";
import { afkPaths } from "../src/runtime/wire.js";

const dirs: string[] = [];
// The launch reaches the host daemon before it spawns anything, and refuses when
// nothing answers (#2851). These cases are about which BUNDLE the launch
// resolves, so the host is stubbed to "answered" and the era migration is pinned
// off — both are covered by their own suites.
const reachesDaemon = async (): Promise<void> => undefined;

const unscoped = { settings: { enabled: false, memoryHigh: "" } };

// The launching process poses as the stranded fleet of #2808: an MCP server on a
// plugin-cache bundle OLDER than the release published underneath it.
const STALE = "2.87.5";
const PUBLISHED = "2.87.7";
const CACHE = "/cache/red-skills/bundles";
const CALLER = "/plugin-cache/dist/castle-mcp.bundle.min.mjs";
const publishedBundle = join(CACHE, `dev-${PUBLISHED}.bundle.min.mjs`);

function stranded(overrides: SupervisorEntryLookup = {}): SupervisorEntryLookup {
  return {
    callerEntry: CALLER,
    execPath: "/usr/bin/node",
    installedVersion: STALE,
    env: { RED_SKILLS_CACHE_DIR: CACHE },
    resolvePublished: () => PUBLISHED,
    exists: (path) => path === publishedBundle,
    ...overrides,
  };
}

afterEach(async () => {
  spawn.mockClear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "supervisor-entry-"));
  dirs.push(value);
  return value;
}

describe("fleet launch entry resolution (#2808)", () => {
  it("spawns the supervisor from the published bundle, not the launching process's own", async () => {
    const cwd = await root();

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      cutoverActive: false,
      root: cwd,
      target: 1,
      runner: "claude",
      probeDeadlineMs: 0,
      scope: unscoped,
      entry: stranded(),
      onNotice: () => undefined,
    });

    const [command, args] = spawn.mock.calls.at(-1) as [string, string[], SpawnOptions];
    expect(command).toBe("/usr/bin/node");
    expect(args[0]).toBe(publishedBundle);
    expect(args).toContain("__supervise");
    expect(args.join(" ")).not.toContain("castle-mcp");
    expect(args.join(" ")).not.toContain(STALE);
  });

  it("names the redirect in the launch output instead of letting it pass silently", async () => {
    const cwd = await root();
    const notices: string[] = [];

    await spawnSupervisor({
      reachDaemon: reachesDaemon,
      cutoverActive: false,
      root: cwd,
      target: 1,
      runner: "claude",
      probeDeadlineMs: 0,
      scope: unscoped,
      entry: stranded(),
      onNotice: (message) => notices.push(message),
    });

    expect(notices.join("\n")).toContain(`published bundle ${PUBLISHED}`);
    expect(notices.join("\n")).toContain(`launching process runs ${STALE}`);
  });

  it("produces a supervisor at the published version even when the launcher is older", () => {
    const entry = resolveSupervisorEntry(stranded());

    expect(entry.version).toBe(PUBLISHED);
    expect(entry.source).toBe("bundle-cache");
    expect(supervisorLaunchVersion(stranded())).toBe(PUBLISHED);
  });

  it("falls forward to a version-pinned dispatch when the published bundle is cached nowhere", () => {
    const entry = resolveSupervisorEntry(stranded({ exists: () => false }));

    expect(entry.version).toBe(PUBLISHED);
    expect(entry.source).toBe("pinned-dispatch");
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "-p", `@reddb-io/red-skills@${PUBLISHED}`, "red-skills-dev"]);
  });

  it("runs the caller's own entry when it is already at the published version", () => {
    const entry = resolveSupervisorEntry(stranded({
      installedVersion: PUBLISHED,
      exists: () => false,
    }));

    expect(entry.source).toBe("caller-entry");
    expect(entry.version).toBe(PUBLISHED);
    expect(entry.args[0]).toBe(join("/plugin-cache/dist", "dev.bundle.min.mjs"));
  });

  it("leaves a local source build running its own bundle, never a cached release", () => {
    const entry = resolveSupervisorEntry(stranded({
      installedVersion: "0.0.0-dev",
      callerEntry: "/repo/apps/dev/dist/cli.js",
    }));

    expect(entry.source).toBe("local-build");
    expect(entry.version).toBe("0.0.0-dev");
    expect(entry.args[0]).toBe("/repo/apps/dev/dist/cli.js");
  });
});

describe("fleet launch published-version failures are loud (#2808)", () => {
  it("refuses the launch when the published version cannot be resolved", async () => {
    const cwd = await root();

    await expect(spawnSupervisor({
      reachDaemon: reachesDaemon,
      cutoverActive: false,
      root: cwd,
      target: 1,
      runner: "claude",
      probeDeadlineMs: 0,
      scope: unscoped,
      entry: stranded({ resolvePublished: () => undefined }),
      onNotice: () => undefined,
    })).rejects.toThrow(PUBLISHED_VERSION_UNRESOLVED);

    expect(spawn.mock.calls).toHaveLength(0);
  });

  it("names the launching bundle it refused to fall back to", () => {
    try {
      resolveSupervisorEntry(stranded({ resolvePublished: () => undefined }));
      expect.unreachable("resolution must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisorEntryError);
      const failure = error as SupervisorEntryError;
      expect(failure.code).toBe(PUBLISHED_VERSION_UNRESOLVED);
      expect(failure.message).toContain(STALE);
      expect(failure.message).toContain("caller's bundle");
    }
  });

  it("refuses loudly, listing what it probed, when no entry runs the published version", () => {
    try {
      resolveSupervisorEntry(stranded({
        exists: () => false,
        env: { RED_SKILLS_CACHE_DIR: CACHE, RED_SKILLS_NO_PINNED_DISPATCH: "1" },
      }));
      expect.unreachable("resolution must throw");
    } catch (error) {
      const failure = error as SupervisorEntryError;
      expect(failure.code).toBe(SUPERVISOR_ENTRY_UNRESOLVED);
      expect(failure.searched).toContain(publishedBundle);
    }
  });
});

describe("the prescribed fix clears the finding it is prescribed for (#2808)", () => {
  it("reports the version the boot probe resolves as published", async () => {
    const cache = await root();
    await writeFile(join(cache, `dev-${PUBLISHED}.bundle.min.mjs`), "//published\n", "utf8");
    const env = { RED_SKILLS_CACHE_DIR: cache };

    // The probe's `latestBundleVersion` and the launch's target version are one
    // function, so a relaunch cannot land on a version the probe still calls skewed.
    const probePublished = resolvePublishedDevBundleVersion(STALE, env);
    const supervisorVersion = resolveSupervisorEntry({
      ...stranded(),
      env,
      resolvePublished: resolvePublishedDevBundleVersion,
      exists: () => false,
    }).version;

    expect(probePublished).toBe(PUBLISHED);
    expect(supervisorVersion).toBe(probePublished);

    const probe = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 4242,
        supervisorPidLive: true,
        nowMs: 10_000,
        heartbeatEpochMs: 9_000,
        heartbeatStaleMs: 300_000,
        bundleVersion: supervisorVersion,
        latestBundleVersion: probePublished,
      },
    });
    expect(probe.evidence).not.toContain("version_skew");
    expect(probe.verdict).not.toBe("red");
  });

  it("stamps the boot-window heartbeat with the launched version, not the launcher's", async () => {
    const cwd = await root();
    const paths = afkPaths(cwd);
    await mkdir(dirname(paths.fleetStatePath), { recursive: true });

    stampFreshFleetHeartbeat(paths.fleetStatePath, 1_700_000_000, "claude", 2, PUBLISHED);
    const stamped = decodeDevSnapshotSniff(readFileSync(paths.fleetStatePath, "utf8")) as Record<string, unknown>;
    expect(stamped.bundle_version).toBe(PUBLISHED);

    // Default: the version the launch would resolve, so no caller has to know it.
    stampFreshFleetHeartbeat(paths.fleetStatePath, 1_700_000_001, "claude", 2);
    const defaulted = decodeDevSnapshotSniff(readFileSync(paths.fleetStatePath, "utf8")) as Record<string, unknown>;
    expect(defaulted.bundle_version).toBe(supervisorLaunchVersion());
  });
});
