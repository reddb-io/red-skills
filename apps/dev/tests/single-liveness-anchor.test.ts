/**
 * Every surface derives from ONE liveness anchor (ADR 0128 §5–§6, issue #2704).
 *
 * `fleet_status` reporting `alive: false` beside a fresh heartbeat (#2698) and
 * the janitor reclaiming the live supervisor's lane (#2679) are the same bug:
 * a writer maintaining one anchor and a reader trusting another. This slice
 * makes the contradiction UNREPRESENTABLE rather than unlikely — liveness and
 * freshness are resolved together, and an unattributable heartbeat is stale at
 * any age — and it ratchets the migration: a reader that reintroduces a private
 * source fails here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const LIVE_PID = 424_242;
const DEAD_PID = 999_999_999;

vi.mock("../src/runtime/kill-tree.js", () => ({
  isLivePid: (pid: number) => pid === LIVE_PID,
  killTreeAndWait: vi.fn(async () => true),
}));

vi.mock("../src/core/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/state.js")>();
  return {
    ...actual,
    readPidStartTime: (pid: number) => (pid === LIVE_PID ? `start-${pid}` : null),
  };
});

import { stopFleet } from "../src/commands/fleet.js";
import { renderFleetBlock } from "../src/core/statusline.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";
import {
  resolveSupervisorLiveness,
  type SupervisorPidDiscovery,
} from "../src/runtime/liveness-anchor.js";
import { collectStatuslineFleet } from "../src/runtime/wire/statusline.js";
import { collectMonitorInputs } from "../src/runtime/wire/monitor.js";
import { afkPaths } from "../src/runtime/wire.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-single-anchor-"));
}

function sink(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}

interface SnapshotOptions {
  pid?: number;
  startTime?: string | null;
  ageS?: number;
  slotsBusy?: number;
}

/** A heartbeat snapshot in the shape the supervisor writes every tick. */
function fleetSnapshot(options: SnapshotOptions = {}): string {
  const pid = options.pid ?? LIVE_PID;
  const epoch = Math.floor(Date.now() / 1_000) - (options.ageS ?? 5);
  const startTime = options.startTime === undefined ? `start-${pid}` : options.startTime;
  const busy = options.slotsBusy ?? 2;
  return encodeDevSnapshotToon({
    ts: new Date(epoch * 1_000).toISOString(),
    epoch,
    runner: "claude",
    target: 3,
    pid,
    ...(startTime !== null ? { pid_start_time: startTime } : {}),
    ready_for_agent: 4,
    slots: { busy, free: 3 - busy, total: 3, parked: 0 },
    slot_pids: [],
    spawns_this_tick: 0,
    churn: { deaths: 0, respawns: 0, window_s: 300 },
  });
}

function lane(root: string, snapshot?: string): ReturnType<typeof afkPaths> {
  const paths = afkPaths(root);
  mkdirSync(paths.supervisorRuntimeDir, { recursive: true });
  if (snapshot !== undefined) writeFileSync(paths.fleetStatePath, snapshot, "utf8");
  return paths;
}

describe("the anchor resolves liveness and freshness together (#2704)", () => {
  it("makes `alive: false` beside a fresh heartbeat unrepresentable across every input", () => {
    const nowS = 1_800_000_000;
    const discoveries: (SupervisorPidDiscovery | null)[] = [
      null,
      { pid: LIVE_PID, source: "pid-file", path: "/lane/afk-supervisor.pid" },
      { pid: LIVE_PID, source: "fleet-state", path: "/lane/state.toon" },
    ];
    const epochs = [null, nowS, nowS - 1, nowS - 13, nowS - 299, nowS - 300, nowS - 4_000];

    for (const discovered of discoveries) {
      for (const heartbeatEpoch of epochs) {
        const verdict = resolveSupervisorLiveness({
          discovered,
          heartbeatEpoch,
          nowS,
          staleAfterS: 300,
        });
        // THE invariant: an absent supervisor never publishes a current
        // heartbeat, so "absent beside a fresh heartbeat and busy slots" has no
        // representation for a caller to produce.
        if (!verdict.alive) {
          expect(verdict.heartbeat.stale).toBe(true);
          expect(verdict.heartbeat.reason).not.toBe("fresh");
          expect(verdict.pid).toBe(0);
          expect(verdict.anchor).toBe("none");
        }
        if (!verdict.heartbeat.stale) expect(verdict.alive).toBe(true);
      }
    }
  });

  it("calls a recent heartbeat with no live writer orphaned, never fresh", () => {
    const nowS = 1_800_000_000;
    const verdict = resolveSupervisorLiveness({
      discovered: null,
      heartbeatEpoch: nowS - 13,
      nowS,
      staleAfterS: 300,
    });

    expect(verdict.alive).toBe(false);
    expect(verdict.heartbeat).toMatchObject({ age_s: 13, stale: true, reason: "orphaned" });
  });
});

describe("fleet_status derives its whole supervisor block from the anchor (#2704)", () => {
  it("never reports alive:false alongside a fresh heartbeat and busy slots", async () => {
    const root = scratch();
    try {
      // The exact reported lane (#2698): ticking heartbeat, two busy slots, no
      // pid file — the shape that used to read back as absent.
      lane(root, fleetSnapshot({ ageS: 13, slotsBusy: 2 }));

      const status = await createCastleMcpDependencies(root).fleetStatus({ name: "default" });

      expect(status.slots.busy).toBe(2);
      expect(status.supervisor.alive).toBe(true);
      expect(status.supervisor.pid).toBe(LIVE_PID);
      expect(status.supervisor.identity_anchor).toBe("fleet-state");
      expect(status.supervisor.heartbeat).toMatchObject({ stale: false, reason: "fresh" });
      expect(status.supervisor.heartbeat.age_s).toBe(status.supervisor.heartbeat_age_s);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes the staleness inside the payload when no anchor names a live supervisor", async () => {
    const root = scratch();
    try {
      lane(root, fleetSnapshot({ pid: DEAD_PID, ageS: 9 }));

      const status = await createCastleMcpDependencies(root).fleetStatus({ name: "default" });

      expect(status.supervisor.alive).toBe(false);
      expect(status.supervisor.identity_anchor).toBe("none");
      // A nine-second-old snapshot from a dead writer is history, not now.
      expect(status.supervisor.heartbeat).toMatchObject({ stale: true, reason: "orphaned" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fleet_stop acts on the supervisor the anchor names (#2704)", () => {
  it("signals the snapshot-anchored supervisor and reports what it stopped", async () => {
    const root = scratch();
    try {
      lane(root, fleetSnapshot());

      const result = await stopFleet(root, sink(), "default", { force: true });

      // Not `status: none` on a fleet it could see working — it names the pid
      // it stopped AND the anchor that named it.
      expect(result).toMatchObject({
        status: "stopped",
        pid: LIVE_PID,
        anchor: "fleet-state",
      });
      const { killTreeAndWait } = await import("../src/runtime/kill-tree.js");
      expect(vi.mocked(killTreeAndWait)).toHaveBeenCalledWith(LIVE_PID);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports `none` with the anchor only when no anchor names a supervisor at all", async () => {
    const root = scratch();
    try {
      lane(root);

      const result = await stopFleet(root, sink(), "default", { force: true });

      expect(result).toMatchObject({ status: "none", anchor: "none" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the monitor publishes the anchor's verdict, not its own (#2704)", () => {
  it("carries supervisor liveness and staleness beside the rendered snapshot", async () => {
    const root = scratch();
    try {
      lane(root, fleetSnapshot({ ageS: 7 }));

      const inputs = await collectMonitorInputs(root);

      expect(inputs.supervisor).toMatchObject({
        alive: true,
        pid: LIVE_PID,
        identity_anchor: "fleet-state",
      });
      expect(inputs.supervisor.heartbeat.stale).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a stale read renders as stale, never as current (#2704)", () => {
  it("marks the statusline fleet segment stale when the heartbeat is orphaned", async () => {
    const root = scratch();
    try {
      lane(root, fleetSnapshot({ pid: DEAD_PID, ageS: 11 }));

      const chip = await collectStatuslineFleet({ root, repo: "", remote: "origin" });

      expect(chip).toBeDefined();
      expect(chip).toMatchObject({ stale: true, staleAgeS: 11 });
      // The rendered line SAYS stale — the dead fleet's last numbers are never
      // drawn as the current occupancy.
      expect(renderFleetBlock(chip)).toContain("stale=11s");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a live fleet with no stale marker at all", async () => {
    const root = scratch();
    try {
      lane(root, fleetSnapshot({ ageS: 4 }));

      const chip = await collectStatuslineFleet({ root, repo: "", remote: "origin" });

      expect(chip?.stale).toBeUndefined();
      expect(renderFleetBlock(chip)).not.toContain("stale=");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// the ratchet: no migrated reader may hold a private liveness source
// ---------------------------------------------------------------------------

/**
 * The five surfaces ADR 0128 §5 names, plus the module each of them lives in.
 * Adding a surface here is the migration; adding one that reaches past the
 * anchor is what this test refuses.
 */
const MIGRATED_READERS = [
  { surface: "fleet_status / fleet_create / fleet_register / worker_vitals", file: "src/mcp-adapter.ts" },
  { surface: "fleet_stop / fleet status CLI", file: "src/commands/fleet.ts" },
  { surface: "monitor", file: "src/runtime/wire/monitor.ts" },
  { surface: "statusline", file: "src/runtime/wire/statusline.ts" },
] as const;

/** The private sources a migrated reader must no longer own (ADR 0128 §5). */
const PRIVATE_SOURCE_MODULE = "supervisor-state.js";
const ANCHOR_MODULE = "liveness-anchor.js";

function importsModule(source: string, moduleSuffix: string): boolean {
  return new RegExp(`from\\s+"[^"]*${moduleSuffix.replace(".", "\\.")}"`).test(source);
}

describe("one anchor, enforced (#2704)", () => {
  it.each(MIGRATED_READERS)(
    "$surface resolves liveness through the anchor and holds no private source",
    ({ file }) => {
      const source = readFileSync(join(HERE, "..", file), "utf8");

      expect(importsModule(source, ANCHOR_MODULE)).toBe(true);
      expect(importsModule(source, PRIVATE_SOURCE_MODULE)).toBe(false);
    },
  );

  it("fails a reader that reintroduces a private source", () => {
    // The negative control: the same check that passes the migrated readers
    // above must REJECT this, or the ratchet proves nothing.
    const offending = [
      'import { discoverLiveSupervisorPid } from "../runtime/supervisor-state.js";',
      "const pid = await discoverLiveSupervisorPid(dir, isLivePid);",
    ].join("\n");

    expect(importsModule(offending, ANCHOR_MODULE)).toBe(false);
    expect(importsModule(offending, PRIVATE_SOURCE_MODULE)).toBe(true);
  });
});
