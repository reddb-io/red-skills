import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readWorkerState, readWorkerStates } from "../src/core/worker-state-reader.js";
import { LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";

const NOW = Date.UTC(2026, 5, 22, 12, 0, 0);
const fresh = new Date(NOW - 5_000).toISOString();
const old = new Date(NOW - 10 * 60_000).toISOString();
// Lane timestamps: fresh = 5s ago (within LIVENESS_LANE_IDLE_MS=180s),
// stale = 200s ago (beyond the display threshold).
const LANE_FRESH_MS = NOW - 5_000;
const LANE_STALE_MS = NOW - 200_000;
/** Write a liveness lane file with a single iteration-start record at `atMs`. */
async function writeLaneLine(dir: string, atMs: number): Promise<void> {
  await writeFile(
    join(dir, LIVENESS_LANE_FILENAME),
    JSON.stringify({ at: atMs, kind: "iteration-start" }) + "\n",
    "utf8",
  );
}
/** ps snapshot string where `pid` has a child at `childPid`. */
function psWithChild(pid: number, childPid: number): string {
  return `1 0\n${pid} 1\n${childPid} ${pid}\n`;
}

async function writeState(dir: string, raw: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "afk.state.json");
  await writeFile(path, JSON.stringify(raw), "utf8");
  return path;
}

describe("worker-state-reader", () => {
  it("reads a live worker (fresh liveness lane → active)", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-live-"));
    const path = await writeState(base, {
      worker_id: "wLIVE",
      pid: 4242,
      current: { number: 824, stage: "impl", last_event_at: fresh },
    });
    // Fresh lane → evaluator: "alive", laneFresh: true → "active".
    const rec = readWorkerState(path, { nowMs: NOW, laneRecencyMs: LANE_FRESH_MS });
    expect(rec).not.toBeNull();
    expect(rec!.state.worker_id).toBe("wLIVE");
    expect(rec!.state.current.number).toBe(824);
    expect(rec!.live).toBe(true);
    expect(rec!.active).toBe(true);
    expect(rec!.liveness).toBe("active");
  });

  it("reads a stale-lane worker with live descendants as quiet-but-live", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-stale-"));
    const path = await writeState(base, {
      worker_id: "wSTALE",
      pid: 4242,
      current: { number: 7, last_event_at: old },
    });
    // Stale lane (200s > 180s idle) + pid 4242 has a child → "alive" (cross-check).
    const rec = readWorkerState(path, {
      nowMs: NOW,
      laneRecencyMs: LANE_STALE_MS,
      psSnapshot: () => psWithChild(4242, 9999),
    });
    expect(rec!.live).toBe(true);
    expect(rec!.active).toBe(false);
    expect(rec!.liveness).toBe("quiet-but-live");
  });

  it("a worker with a stale lane and no live descendants is dead", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-dead-"));
    const path = await writeState(base, { pid: 4242, current: { last_event_at: fresh } });
    // No lane + no descendants → evaluator: "stalled".
    const rec = readWorkerState(path, { nowMs: NOW, psSnapshot: () => "" });
    expect(rec!.live).toBe(false);
    expect(rec!.active).toBe(false);
    expect(rec!.liveness).toBe("dead");
  });

  it("a worker whose lane is absent and pid has no descendants is dead (recycled-pid case)", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-reused-pid-"));
    const path = await writeState(base, {
      worker_id: "wOLD",
      pid: 4242,
      pid_start_time: "old-start",
      current: { last_event_at: fresh },
    });
    // No lane + empty ps snapshot → evaluator: "stalled" regardless of the old pid identity.
    const rec = readWorkerState(path, { nowMs: NOW, psSnapshot: () => "" });
    expect(rec!.live).toBe(false);
    expect(rec!.active).toBe(false);
    expect(rec!.liveness).toBe("dead");
  });

  it("reads a LEGACY-keyed file identically through the shared parseState shim", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-legacy-"));
    // ADR 0065 legacy keys: diff_added/diff_removed, thinking_called_count,
    // last_progress_at. The shim must map them onto the canonical names — the
    // exact divergence the hand-rolled JSON.parse path used to miss.
    const path = await writeState(base, {
      worker_id: "wLEGACY",
      pid: 4242,
      current: {
        number: 99,
        diff_added: 12,
        diff_removed: 3,
        thinking_called_count: 5,
        last_progress_at: fresh,
      },
    });
    // Fresh lane → evaluator "alive" so the legacy worker reads active.
    const rec = readWorkerState(path, { nowMs: NOW, laneRecencyMs: LANE_FRESH_MS });
    expect(rec!.state.current.loc_added).toBe(12);
    expect(rec!.state.current.loc_removed).toBe(3);
    expect(rec!.state.current.reasoning_events).toBe(5);
    expect(rec!.state.current.last_commit_at).toBe(fresh);
    expect(rec!.active).toBe(true);
  });

  it("returns null for a missing file", () => {
    expect(readWorkerState(join(tmpdir(), "nope", "afk.state.json"))).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-bad-"));
    const path = join(base, "afk.state.json");
    await writeFile(path, "{ not json", "utf8");
    expect(readWorkerState(path)).toBeNull();
  });

  it("readWorkerStates globs + tags every record, dropping unreadable ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsr-many-"));
    const dirA = join(root, "wA", "1-a1");
    const dirB = join(root, "wB", "2-a1");
    const live = await writeState(dirA, {
      worker_id: "wA",
      pid: 1,
      current: { number: 1, last_event_at: fresh },
    });
    const stale = await writeState(dirB, {
      worker_id: "wB",
      pid: 2,
      current: { number: 2, last_event_at: old },
    });
    // Write a fresh liveness lane for wA so it reads "active".
    await writeLaneLine(dirA, LANE_FRESH_MS);
    // wB gets a stale lane + a child in the ps snapshot → "quiet-but-live".
    await writeLaneLine(dirB, LANE_STALE_MS);
    // A bogus path the fake glob yields but that does not exist → dropped.
    const recs = await readWorkerStates(root, {
      nowMs: NOW,
      psSnapshot: () => psWithChild(2, 9999), // pid 2 has a child → wB is quiet-but-live
      glob: async () => [live, stale, join(root, "ghost", "afk.state.json")],
    });
    expect(recs).toHaveLength(2);
    const byId = Object.fromEntries(recs.map((r) => [r.state.worker_id, r]));
    expect(byId.wA!.active).toBe(true);
    expect(byId.wB!.active).toBe(false);
    expect(byId.wB!.live).toBe(true);
  });
});
