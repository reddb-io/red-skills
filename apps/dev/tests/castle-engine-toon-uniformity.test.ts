// Uniformity sweep for the castle-engine write surfaces (issue #2008 / #2009).
//
// The maintainer's standing rule is total: every file the fleet runtime writes
// is TOON (TOONL for line-oriented lanes). The single sanctioned non-TOON file
// is the repo config YAML `.red/config.yaml` — the protocol owner (the human +
// the loader) sets that format, so it is exempt by contract (ADR 0097). This
// test enumerates the castle-engine snapshot/state writers and FAILS on any raw
// JSON emission, so a future engine relocation cannot silently regress the
// uniformity the TOON waves established.

import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import {
  CASTLE_LANE_FILENAMES,
  castleStateSnapshotPath,
  createEnginePaths,
} from "@reddb-io/red-castle/engine";
import {
  IDENTITY_FILENAME,
  writeIdentitySync,
  writeStateAtomic,
  defaultState,
} from "../src/core/state.js";
import { fleetHeartbeatState } from "../src/commands/supervise.js";
import { stampFreshFleetHeartbeat } from "../src/runtime/supervisor-spawn.js";
import { writeLogLineCursors } from "../src/runtime/log-cursor.js";
import { buildWatchdogIO } from "../src/runtime/watchdog-io.js";
import { afkPaths } from "../src/runtime/wire.js";
import type { FleetHeartbeat } from "../src/core/supervisor.js";

/** The single sanctioned non-TOON file the stack writes (ADR 0097). */
const SOLE_NON_TOON_FILE = ".red/config.yaml";

/** Assert a snapshot document's bytes are TOON, never raw JSON. Raw JSON of an
 * object/non-empty array starts with `{`/`[` and round-trips through
 * `JSON.parse`; TOON `decode` throws on those header shapes, so a document that
 * `decode`s AND fails `JSON.parse` is provably not raw JSON. */
function expectToonNotJson(bytes: string, expected: unknown): void {
  expect(() => JSON.parse(bytes)).toThrow();
  expect(decode(bytes)).toEqual(expected);
}

function sampleHeartbeat(): FleetHeartbeat {
  return {
    ts: "2026-07-17T00:00:00.000Z",
    epoch: 42,
    lastProgressEpoch: 41,
    runner: "claude",
    bundleVersion: "9.9.9",
    readyForAgent: 3,
    slotsBusy: 1,
    slotsFree: 1,
    slotsTotal: 2,
    slotsParked: 0,
    spawnsThisTick: 0,
  } as FleetHeartbeat;
}

describe("castle-engine write-surface TOON uniformity", () => {
  it("the worker identity stamp is TOON, never raw JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "castle-toon-identity-"));
    const identity = {
      worker_id: "wAB12",
      runner: "claude",
      origin: "afk",
      number: 2009,
      started_at: "2026-07-17T00:00:00.000Z",
    };
    writeIdentitySync(dir, identity);
    const bytes = await readFile(join(dir, IDENTITY_FILENAME), "utf8");
    expectToonNotJson(bytes, identity);
  });

  it("the per-attempt worker state snapshot is TOON, never raw JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "castle-toon-state-"));
    const path = join(dir, "afk.state.json");
    const state = defaultState();
    await writeStateAtomic(path, state);
    const bytes = await readFile(path, "utf8");
    // A populated AfkState never encodes to raw JSON under the TOON encoder.
    expect(() => JSON.parse(bytes)).toThrow();
    expect(decode(bytes)).toBeTruthy();
  });

  it("the supervisor state snapshot serializer emits TOON, never raw JSON", () => {
    const bytes = fleetHeartbeatState(sampleHeartbeat());
    expect(() => JSON.parse(bytes)).toThrow();
    const decoded = decode(bytes) as Record<string, unknown>;
    expect(decoded.epoch).toBe(42);
    expect(decoded.slots).toEqual({ busy: 1, free: 1, total: 2, parked: 0 });
  });

  it("the fresh-relaunch supervisor heartbeat stamp is TOON, never raw JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "castle-toon-stamp-"));
    const path = join(dir, "afk-supervisor.state.json");
    stampFreshFleetHeartbeat(path, 7, "claude", 2);
    const bytes = await readFile(path, "utf8");
    expect(() => JSON.parse(bytes)).toThrow();
    const decoded = decode(bytes) as Record<string, unknown>;
    expect(decoded.epoch).toBe(7);
    expect(decoded.slots).toEqual({ busy: 0, free: 2, total: 2, parked: 0 });
  });

  it("the supervisor restart ledger is TOON, never raw JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-toon-restarts-"));
    const io = buildWatchdogIO(root);
    // The supervisor ensures the state-tier dir before writing; mirror that here.
    await mkdir(dirname(afkPaths(root).supervisorRestartsPath), { recursive: true });
    await io.writeRestartLedger!([100, 200, 300]);
    const roundTripped = await io.readRestartLedger!();
    expect(roundTripped).toEqual([100, 200, 300]);
    const bytes = await readFile(afkPaths(root).supervisorRestartsPath, "utf8");
    expectToonNotJson(bytes, [100, 200, 300]);
  });

  it("the monitor log-cursor snapshot is TOON, never raw JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "castle-toon-cursors-"));
    const path = join(dir, "monitor-log-cursors.json");
    const cursors = { "/x/afk.log": { size: 5, lines: 1 } };
    await writeLogLineCursors(path, cursors);
    const bytes = await readFile(path, "utf8");
    expectToonNotJson(bytes, cursors);
  });

  it("every castle-engine lane and state snapshot filename is born TOON/TOONL", () => {
    const paths = createEnginePaths(join(tmpdir(), ".red"));
    const suffixes = [
      ...Object.values(CASTLE_LANE_FILENAMES),
      castleStateSnapshotPath(paths, "supervisor", "s"),
      castleStateSnapshotPath(paths, "worker", "w"),
    ];
    for (const name of suffixes) {
      expect(name.endsWith(".toon") || name.endsWith(".toonl")).toBe(true);
      expect(name.endsWith(".json") || name.endsWith(".jsonl")).toBe(false);
    }
  });

  it("documents .red/config.yaml as the single sanctioned non-TOON file", () => {
    // Contract statement (ADR 0097): the config YAML is the ONLY file the stack
    // writes that is not TOON. No castle-engine snapshot surface above is a YAML
    // or config file — they are all TOON documents.
    expect(SOLE_NON_TOON_FILE).toBe(".red/config.yaml");
    expect(SOLE_NON_TOON_FILE.endsWith(".yaml")).toBe(true);
  });
});
