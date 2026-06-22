import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readWorkerState, readWorkerStates } from "../src/core/worker-state-reader.js";

const NOW = Date.UTC(2026, 5, 22, 12, 0, 0);
const fresh = new Date(NOW - 5_000).toISOString();
const old = new Date(NOW - 10 * 60_000).toISOString();
const aliveKill = (): boolean => true;
const deadKill = (): boolean => false;

async function writeState(dir: string, raw: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "afk.state.json");
  await writeFile(path, JSON.stringify(raw), "utf8");
  return path;
}

describe("worker-state-reader", () => {
  it("reads a live worker (pid resolves AND recently active)", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-live-"));
    const path = await writeState(base, {
      worker_id: "wLIVE",
      pid: 4242,
      current: { number: 824, stage: "impl", last_event_at: fresh },
    });
    const rec = readWorkerState(path, { nowMs: NOW, kill: aliveKill });
    expect(rec).not.toBeNull();
    expect(rec!.state.worker_id).toBe("wLIVE");
    expect(rec!.state.current.number).toBe(824);
    expect(rec!.live).toBe(true);
    expect(rec!.active).toBe(true);
  });

  it("reads a stale worker as live (pid only) but NOT active (old activity)", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-stale-"));
    const path = await writeState(base, {
      worker_id: "wSTALE",
      pid: 4242,
      current: { number: 7, last_event_at: old },
    });
    const rec = readWorkerState(path, { nowMs: NOW, kill: aliveKill });
    expect(rec!.live).toBe(true);
    expect(rec!.active).toBe(false);
  });

  it("a dead pid is neither live nor active", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-dead-"));
    const path = await writeState(base, { pid: 4242, current: { last_event_at: fresh } });
    const rec = readWorkerState(path, { nowMs: NOW, kill: deadKill });
    expect(rec!.live).toBe(false);
    expect(rec!.active).toBe(false);
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
    const rec = readWorkerState(path, { nowMs: NOW, kill: aliveKill });
    expect(rec!.state.current.loc_added).toBe(12);
    expect(rec!.state.current.loc_removed).toBe(3);
    expect(rec!.state.current.reasoning_events).toBe(5);
    expect(rec!.state.current.last_commit_at).toBe(fresh);
    // last_commit_at is an activity fallback, so the legacy worker still reads active.
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
    const live = await writeState(join(root, "wA", "1-a1"), {
      worker_id: "wA",
      pid: 1,
      current: { number: 1, last_event_at: fresh },
    });
    const stale = await writeState(join(root, "wB", "2-a1"), {
      worker_id: "wB",
      pid: 2,
      current: { number: 2, last_event_at: old },
    });
    // A bogus path the fake glob yields but that does not exist → dropped.
    const recs = await readWorkerStates(root, {
      nowMs: NOW,
      kill: aliveKill,
      glob: async () => [live, stale, join(root, "ghost", "afk.state.json")],
    });
    expect(recs).toHaveLength(2);
    const byId = Object.fromEntries(recs.map((r) => [r.state.worker_id, r]));
    expect(byId.wA!.active).toBe(true);
    expect(byId.wB!.active).toBe(false);
    expect(byId.wB!.live).toBe(true);
  });
});
