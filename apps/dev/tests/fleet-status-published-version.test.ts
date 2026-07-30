import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@reddb-io/toon";

const killTreeMocks = vi.hoisted(() => ({
  isLivePid: vi.fn((_pid: number) => false),
  killTreeAndWait: vi.fn(async () => false),
}));

vi.mock("../src/runtime/kill-tree.js", () => ({
  isLivePid: killTreeMocks.isLivePid,
  killTreeAndWait: killTreeMocks.killTreeAndWait,
}));

vi.mock("../src/core/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/state.js")>();
  return { ...actual, readPidStartTime: (pid: number) => `start-${pid}` };
});

import { statusFleet } from "../src/commands/fleet.js";
import { isLivePid } from "../src/runtime/kill-tree.js";
import { afkPaths } from "../src/runtime/wire.js";
import { runFleetTruthProbe } from "../src/core/operational-probes/fleet-truth.js";
import {
  readPublishedBundleVersion,
  writePublishedVersionRecord,
} from "../src/core/published-version.js";

interface SupervisorReport {
  bundle_version: string;
  bundle_latest: string;
  version_unknown: number;
  published_unknown: number;
  version_skew: number;
  published_version: {
    version: string;
    source: string;
    age_ms: number;
    stale_after_ms: number;
    stale: boolean;
    reason: string;
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "fleet-published-version-"));
}

function writeLiveSupervisor(root: string, bundleVersion: string | undefined, pid = 12345): void {
  const paths = afkPaths(root);
  const epoch = Math.floor(Date.now() / 1000);
  mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
  mkdirSync(dirname(paths.fleetStatePath), { recursive: true });
  writeFileSync(paths.supervisorPidPath, String(pid), "utf8");
  writeFileSync(paths.supervisorPidStartPath, `start-${pid}`, "utf8");
  writeFileSync(
    paths.fleetStatePath,
    JSON.stringify({
      epoch,
      last_progress_epoch: epoch,
      runner: "claude",
      ...(bundleVersion ? { bundle_version: bundleVersion } : {}),
      ready_for_agent: 0,
      slots: { busy: 0, free: 2, total: 2, parked: 0 },
    }),
    "utf8",
  );
  vi.mocked(isLivePid).mockImplementation((p) => p === pid);
}

async function readSupervisor(root: string): Promise<SupervisorReport> {
  const writes: string[] = [];
  const out = {
    write: vi.fn((s: string) => {
      writes.push(s);
      return true;
    }),
  } as unknown as NodeJS.WritableStream;
  await statusFleet(root, out);
  return (decode(writes.join("")) as unknown as { supervisor: SupervisorReport }).supervisor;
}

describe("fleet status published-version agreement (#2809)", () => {
  const roots: string[] = [];
  const caches: string[] = [];
  let priorCacheDir: string | undefined;

  beforeEach(() => {
    priorCacheDir = process.env.RED_SKILLS_CACHE_DIR;
    return () => {
      if (priorCacheDir === undefined) delete process.env.RED_SKILLS_CACHE_DIR;
      else process.env.RED_SKILLS_CACHE_DIR = priorCacheDir;
      for (const dir of roots.splice(0).concat(caches.splice(0))) {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  });

  function useCache(): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-published-cache-"));
    caches.push(dir);
    process.env.RED_SKILLS_CACHE_DIR = dir;
    return dir;
  }

  function useRoot(): string {
    const root = scratch();
    roots.push(root);
    return root;
  }

  // The reported outage: the operator surface read a staler local notion of
  // "latest" than the Worker boot probe, and reported healthy while every
  // Worker was halting on the very skew it claimed to measure.
  it("reports the skew the Worker boot probe halts on, from the same resolution", async () => {
    const cacheDir = useCache();
    // The bundle cache lags at 2.87.5; the registry answer this host recorded is 2.87.7.
    writeFileSync(join(cacheDir, "dev-2.87.5.bundle.min.mjs"), "", "utf8");
    writePublishedVersionRecord({ version: "2.87.7", observedAtMs: Date.now() });
    const root = useRoot();
    writeLiveSupervisor(root, "2.87.6");

    const published = readPublishedBundleVersion();
    const supervisor = await readSupervisor(root);

    // One owner, one answer — the operator surface does not re-derive it.
    expect(published.version).toBe("2.87.7");
    expect(supervisor.bundle_latest).toBe(published.version);
    expect(supervisor).toMatchObject({
      bundle_version: "2.87.6",
      version_unknown: 0,
      published_unknown: 0,
      version_skew: 1,
    });

    // The enforcing path, fed by that same resolution, halts this boot.
    const probe = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 12345,
        supervisorPidLive: true,
        nowMs: 10_000,
        heartbeatEpochMs: 9_000,
        heartbeatStaleMs: 300_000,
        bundleVersion: "2.87.6",
        latestBundleVersion: published.version ?? undefined,
      },
    });
    expect(probe.verdict).toBe("red");
    expect(probe.evidence).toContain("bundle=2.87.6 latest=2.87.7");
  });

  it("reports an unresolvable published version as unknown instead of a substituted verdict", async () => {
    useCache(); // empty: no recorded registry answer, no cached bundle
    const root = useRoot();
    writeLiveSupervisor(root, "2.87.6");

    const supervisor = await readSupervisor(root);

    expect(supervisor).toMatchObject({
      bundle_version: "2.87.6",
      bundle_latest: "",
      version_unknown: 0,
      published_unknown: 1,
      // No verdict is computed from a value nothing measured.
      version_skew: 0,
    });
    expect(supervisor.published_version).toMatchObject({ source: "unresolved", reason: "never-observed", stale: true });

    // The boot probe, given the same unresolved answer, records the version as
    // unmeasured rather than matching against a substituted local value.
    const probe = runFleetTruthProbe({
      remoteUrls: [],
      fleetTruth: {
        supervisorPid: 12345,
        supervisorPidLive: true,
        nowMs: 10_000,
        heartbeatEpochMs: 9_000,
        heartbeatStaleMs: 300_000,
        bundleVersion: "2.87.6",
        latestBundleVersion: readPublishedBundleVersion().version ?? undefined,
      },
    });
    expect(probe.verdict).toBe("ok");
  });

  it("carries the staleness of its version answer, so a cached read is never current", async () => {
    const cacheDir = useCache();
    writeFileSync(join(cacheDir, "dev-2.87.5.bundle.min.mjs"), "", "utf8");
    const root = useRoot();
    writeLiveSupervisor(root, "2.87.6");

    const cacheOnly = await readSupervisor(root);
    expect(cacheOnly.bundle_latest).toBe("2.87.5");
    expect(cacheOnly.published_version).toMatchObject({
      version: "2.87.5",
      source: "bundle-cache",
      stale: true,
      reason: "cache-only",
    });

    // An aged-out registry answer is still reported — with its age, and marked stale.
    writePublishedVersionRecord({ version: "2.87.7", observedAtMs: Date.now() - 24 * 60 * 60_000 });
    const agedOut = await readSupervisor(root);
    expect(agedOut.published_version).toMatchObject({ version: "2.87.7", source: "recorded", stale: true, reason: "aged-out" });
    expect(agedOut.published_version.age_ms).toBeGreaterThan(agedOut.published_version.stale_after_ms);

    const fresh = (() => {
      writePublishedVersionRecord({ version: "2.87.7", observedAtMs: Date.now() });
      return readPublishedBundleVersion();
    })();
    expect(fresh).toMatchObject({ source: "recorded", stale: false, reason: "fresh" });
  });

  it("keeps an unmeasured running bundle distinct from a measured match (#2752)", async () => {
    useCache();
    writePublishedVersionRecord({ version: "2.87.7", observedAtMs: Date.now() });
    const root = useRoot();
    writeLiveSupervisor(root, undefined);

    const supervisor = await readSupervisor(root);
    expect(supervisor).toMatchObject({
      bundle_version: "",
      version_unknown: 1,
      published_unknown: 0,
      version_skew: 0,
    });
  });

  // A structural guard: the enforcing path must keep deriving its published
  // version from the shared owner. A second local derivation here is the
  // two-source contradiction this issue removed.
  it("derives the boot probe's published version from the shared owner", () => {
    const bootWire = readFileSync(new URL("../src/runtime/wire/boot.ts", import.meta.url), "utf8");
    expect(bootWire).toContain("published-version.js");
    expect(bootWire).toMatch(/latestBundleVersion\s*=\s*published\.version/);
  });
});
