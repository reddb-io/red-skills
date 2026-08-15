import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode, encode } from "@reddb-io/toon";
import {
  readWorkerState,
  readWorkerStateDocument,
  readWorkerStates,
  readAllWorkerStates,
  isRenderableLive,
} from "../src/core/worker-state-reader.js";
import { initStateSync, WORKER_STATE_FILENAME, workerStatePath } from "../src/core/state.js";
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
  const path = join(dir, "afk.state.toon");
  await writeFile(path, JSON.stringify(raw), "utf8");
  return path;
}

describe("worker-state-reader", () => {
  it("reads a live worker (fresh liveness lane → active)", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-live-"));
    const path = await writeState(base, {
      worker_id: "wLIVE",
      pid: 4242,
      current: { number: 824, activity: "impl", last_event_at: fresh },
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

  it("reads a TOON attempt-state snapshot through the same schema path", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-toon-"));
    const path = join(base, "afk.state.toon");
    await mkdir(base, { recursive: true });
    await writeFile(
      path,
      encode({
        worker_id: "wTOON",
        pid: 4242,
        current: {
          number: 1783,
          loc_added: 12,
          loc_removed: 2,
          last_event_at: fresh,
        },
      }),
      "utf8",
    );

    const rec = readWorkerState(path, { nowMs: NOW, laneRecencyMs: LANE_FRESH_MS });
    expect(rec).not.toBeNull();
    expect(rec!.state.worker_id).toBe("wTOON");
    expect(rec!.state.current.number).toBe(1783);
    expect(rec!.state.current.loc_added).toBe(12);
    expect(rec!.active).toBe(true);
  });

  it("writes the attempt-state snapshot as spec-valid TOON", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-write-toon-"));
    const path = join(base, "afk.state.toon");
    initStateSync(path, {
      worker_id: "wWRITE",
      pid: 4242,
      "current.number": 1783,
      "current.activity": "setup",
    });

    const raw = await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"));
    expect(raw.trimStart().startsWith("{")).toBe(false);
    const decoded = decode(raw) as { worker_id?: string; current?: { number?: number } };
    expect(decoded.worker_id).toBe("wWRITE");
    expect(decoded.current?.number).toBe(1783);
  });

  it("returns null for a missing file", () => {
    expect(readWorkerState(join(tmpdir(), "nope", "afk.state.toon"))).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-bad-"));
    const path = join(base, "afk.state.toon");
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
      glob: async () => [live, stale, join(root, "ghost", "afk.state.toon")],
    });
    expect(recs).toHaveLength(2);
    const byId = Object.fromEntries(recs.map((r) => [r.state.worker_id, r]));
    expect(byId.wA!.active).toBe(true);
    expect(byId.wB!.active).toBe(false);
    expect(byId.wB!.live).toBe(true);
  });

  it("readAllWorkerStates unions every worker-lane namespace under tmp", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "wsr-union-"));
    // One live worker per lane: fleet, /go, and --scout.
    await writeState(join(tmp, "workers", "wFLEET", "10-a1"), {
      worker_id: "wFLEET",
      pid: 1,
      origin: "afk",
      current: { number: 10, last_event_at: fresh },
    });
    await writeState(join(tmp, "go-workers", "wGO", "20-a1"), {
      worker_id: "wGO",
      pid: 2,
      origin: "go",
      current: { number: 20, last_event_at: fresh },
    });
    await writeState(join(tmp, "scout-workers", "wSCOUT", "30-a1"), {
      worker_id: "wSCOUT",
      pid: 3,
      origin: "scout",
      current: { number: 30, last_event_at: fresh },
    });
    const recs = await readAllWorkerStates(tmp, { nowMs: NOW });
    const byId = Object.fromEntries(recs.map((r) => [r.state.worker_id, r]));
    // All three lanes are discovered, each carrying its own origin provenance.
    expect(Object.keys(byId).sort()).toEqual(["wFLEET", "wGO", "wSCOUT"]);
    expect(byId.wFLEET!.state.origin).toBe("afk");
    expect(byId.wGO!.state.origin).toBe("go");
    expect(byId.wSCOUT!.state.origin).toBe("scout");
  });

  it("readAllWorkerStates with only the fleet lane matches today's single-lane read", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "wsr-union-fleet-"));
    await writeState(join(tmp, "workers", "wFLEET", "11-a1"), {
      worker_id: "wFLEET",
      pid: 1,
      current: { number: 11, last_event_at: fresh },
    });
    // No go-workers/ or scout-workers/ dirs → those lanes contribute nothing.
    const union = await readAllWorkerStates(tmp, { nowMs: NOW });
    const single = await readWorkerStates(join(tmp, "workers"), { nowMs: NOW });
    expect(union.map((r) => r.state.worker_id)).toEqual(["wFLEET"]);
    expect(union.map((r) => r.state.worker_id)).toEqual(single.map((r) => r.state.worker_id));
  });

  // Isolation fallback: worker.pid liveness when afk.state.toon.pid === 0
  it("isolation: live worker.pid + pid:0 state → quiet-but-live, issue derived from path", async () => {
    // Path must look like {worker}/{issue}/afk.state.toon so issue derivation
    // works — flat, no attempt ordinal (ADR 0103).
    const base = await mkdtemp(join(tmpdir(), "wsr-iso-live-"));
    const attemptDir = join(base, "wISO", "1085");
    const path = await writeState(attemptDir, { pid: 0, current: {} });
    // No liveness lane (empty lane), workerPidContent = live pid, kill returns true.
    const rec = readWorkerState(path, {
      nowMs: NOW,
      workerPidContent: "9876",
      kill: () => true,
    });
    expect(rec).not.toBeNull();
    // Worker.pid is alive → quiet-but-live (state.pid=0, lane empty, but host pid alive).
    expect(rec!.live).toBe(true);
    expect(rec!.active).toBe(false);
    expect(rec!.liveness).toBe("quiet-but-live");
    // Issue number derived from the flat "1085" issue-dir basename.
    expect(rec!.state.current.number).toBe(1085);
    // Evaluator verdict carries the isolation-fallback reason.
    expect(rec!.livenessVerdict.status).toBe("alive");
    expect(rec!.livenessVerdict.reason).toContain("worker.pid=9876 is alive");
  });

  // issue #1219 PART 2: a live isolation worker whose host-side state is zeroed
  // renders its real identity from the durable identity.toon sidecar.
  it("isolation: hostPidLive + zeroed state → real worker_id/runner/origin/started_at from identity.toon", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-iso-identity-"));
    const attemptDir = join(base, "wISO", "1181-a1");
    // Fully zeroed host state (pre-sync isolation worker): pid 0, empty identity.
    const path = await writeState(attemptDir, { pid: 0, current: {} });
    const identity = JSON.stringify({
      worker_id: "wREAL",
      runner: "claude",
      origin: "go",
      number: 1181,
      started_at: "2026-07-06T10:00:00Z",
    });
    const rec = readWorkerState(path, {
      nowMs: NOW,
      workerPidContent: "9876",
      kill: () => true,
      identityContent: identity,
    });
    expect(rec).not.toBeNull();
    // Real identity, NOT the zeroed schema default (no `?  run=-  00:00:00` ghost).
    expect(rec!.state.worker_id).toBe("wREAL");
    expect(rec!.state.runner).toBe("claude");
    expect(rec!.state.origin).toBe("go");
    expect(rec!.state.started_at).toBe("2026-07-06T10:00:00Z");
    expect(rec!.state.current.number).toBe(1181);
    // A live isolation worker is renderable.
    expect(rec!.renderableLive).toBe(true);
    expect(rec!.hostPidLive).toBe(true);
  });

  // The identity sidecar never overwrites a value the state file already carries.
  it("isolation: identity.toon does not clobber a populated state field", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-iso-nonclobber-"));
    const attemptDir = join(base, "wISO", "1181-a1");
    const path = await writeState(attemptDir, { pid: 0, worker_id: "wKEEP", current: {} });
    const identity = JSON.stringify({
      worker_id: "wIDENTITY",
      runner: "codex",
      origin: "afk",
      number: 1181,
      started_at: "2026-07-06T10:00:00Z",
    });
    const rec = readWorkerState(path, {
      nowMs: NOW,
      workerPidContent: "9876",
      kill: () => true,
      identityContent: identity,
    });
    expect(rec!.state.worker_id).toBe("wKEEP");
    // Empty fields still fall back to the identity.
    expect(rec!.state.runner).toBe("codex");
  });

  it("isolation: dead worker.pid + pid:0 state → dead", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-iso-dead-"));
    const attemptDir = join(base, "wISO", "1085-a1");
    const path = await writeState(attemptDir, { pid: 0, current: {} });
    // kill returns false → host pid is dead.
    const rec = readWorkerState(path, {
      nowMs: NOW,
      workerPidContent: "9876",
      kill: () => false,
    });
    expect(rec).not.toBeNull();
    expect(rec!.live).toBe(false);
    expect(rec!.liveness).toBe("dead");
  });

  it("isolation: hostPidLive does not readmit a retained sibling attempt", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-iso-sibling-"));
    const workerDir = join(base, "wISO");
    const retainedDir = join(workerDir, "1775-a1");
    const currentDir = join(workerDir, "1811-a1");
    const retainedPath = await writeState(retainedDir, {
      worker_id: "wISO",
      pid: 0,
      current: { number: 1775 },
    });
    const currentPath = await writeState(currentDir, {
      worker_id: "wISO",
      pid: 0,
      current: { number: 1811 },
    });
    await writeFile(join(workerDir, "worker.pid"), "9876", "utf8");
    await utimes(retainedDir, new Date("2026-07-06T10:00:00Z"), new Date("2026-07-06T10:00:00Z"));
    await utimes(currentDir, new Date("2026-07-06T10:10:00Z"), new Date("2026-07-06T10:10:00Z"));

    const retained = readWorkerState(retainedPath, { nowMs: NOW, kill: () => true });
    const current = readWorkerState(currentPath, { nowMs: NOW, kill: () => true });

    expect(retained!.hostPidLive).toBe(false);
    expect(retained!.renderableLive).toBe(false);
    expect(current!.hostPidLive).toBe(true);
    expect(current!.renderableLive).toBe(true);
  });

  it("regression: normal no-sandbox worker with populated pid + fresh lane renders as active", async () => {
    const base = await mkdtemp(join(tmpdir(), "wsr-normal-reg-"));
    const path = await writeState(base, {
      worker_id: "wNORMAL",
      pid: 4242,
      current: { number: 999, activity: "impl", last_event_at: fresh },
    });
    // Fresh liveness lane → evaluator "alive", laneFresh=true → "active".
    const rec = readWorkerState(path, { nowMs: NOW, laneRecencyMs: LANE_FRESH_MS });
    expect(rec).not.toBeNull();
    expect(rec!.live).toBe(true);
    expect(rec!.active).toBe(true);
    expect(rec!.liveness).toBe("active");
    // Issue number from state, not derived from path.
    expect(rec!.state.current.number).toBe(999);
    // The isolation fallback must NOT have fired (worker.pid check is skipped when state.pid > 0).
    expect(rec!.livenessVerdict.reason).not.toContain("worker.pid");
  });

  // issue #1219 PART 1: the ONE shared render-gate predicate.
  describe("isRenderableLive predicate", () => {
    const verdict = (status: "alive" | "stalled" | "unknown") =>
      ({ status, laneFresh: false, crossCheckArmed: false, reason: "" }) as const;

    it("drops a stalled worker even when pid identity is live", () => {
      expect(
        isRenderableLive({ livenessVerdict: verdict("stalled"), pidIdentityLive: true, hostPidLive: false }),
      ).toBe(false);
    });

    it("drops a not-stalled record with neither pid signal (finished pid-0 sibling)", () => {
      expect(
        isRenderableLive({ livenessVerdict: verdict("alive"), pidIdentityLive: false, hostPidLive: false }),
      ).toBe(false);
    });

    it("keeps a live worker (not stalled + pid identity live)", () => {
      expect(
        isRenderableLive({ livenessVerdict: verdict("alive"), pidIdentityLive: true, hostPidLive: false }),
      ).toBe(true);
    });

    it("keeps a live isolation worker (not stalled + host pid live)", () => {
      expect(
        isRenderableLive({ livenessVerdict: verdict("alive"), pidIdentityLive: false, hostPidLive: true }),
      ).toBe(true);
    });

    it("readWorkerState computes renderableLive consistently for stalled/live", async () => {
      const base = await mkdtemp(join(tmpdir(), "wsr-renderable-"));
      // Live: populated pid + fresh lane.
      const livePath = await writeState(join(base, "wA", "5-a1"), {
        worker_id: "wA", pid: 4242, current: { number: 5, last_event_at: fresh },
      });
      const live = readWorkerState(livePath, { nowMs: NOW, laneRecencyMs: LANE_FRESH_MS, kill: () => true });
      expect(live!.renderableLive).toBe(true);
      // Stalled: pid 0, stale lane, no host pid → dead.
      const deadPath = await writeState(join(base, "wB", "6-a1"), {
        worker_id: "wB", pid: 0, current: { number: 6 },
      });
      const dead = readWorkerState(deadPath, { nowMs: NOW, laneRecencyMs: LANE_STALE_MS, kill: () => false });
      expect(dead!.renderableLive).toBe(false);
    });
  });
});

describe("readWorkerStateDocument", () => {
  it("names the Worker state file once, for every consumer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wsd-name-"));
    expect(WORKER_STATE_FILENAME).toBe("afk.state.toon");
    expect(workerStatePath(dir)).toBe(join(dir, WORKER_STATE_FILENAME));
  });

  it("reads a TOON document through the single owning parse path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wsd-toon-"));
    const path = workerStatePath(dir);
    initStateSync(path, { worker_id: "wZZZZ", pid: 77, "current.number": 2783 });

    const state = readWorkerStateDocument(path);
    expect(state?.worker_id).toBe("wZZZZ");
    expect(state?.current.number).toBe(2783);
    // The on-disk document is TOON, never a JSON serialization.
    const text = readFileSync(path, "utf8");
    expect(() => JSON.parse(text)).toThrow();
    expect(decode(text)).toMatchObject({ worker_id: "wZZZZ" });
  });

  it.each([
    {
      label: "with session evidence",
      updates: { session_artifact: "/sessions/wSESS/runner-session.toon" },
      expected: "/sessions/wSESS/runner-session.toon",
    },
    { label: "without session evidence", updates: {}, expected: "" },
  ])("round-trips a Worker state fixture $label", ({ updates, expected }) => {
    const dir = join(tmpdir(), `wsd-session-${expected ? "present" : "absent"}`);
    const path = workerStatePath(dir);
    initStateSync(path, { worker_id: "wSESS", "current.number": 3834, ...updates });

    expect(readWorkerStateDocument(path)?.session_artifact).toBe(expected);
  });

  it("still reads a pre-migration JSON document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wsd-json-"));
    const path = workerStatePath(dir);
    await writeFile(path, JSON.stringify({ worker_id: "wLEGACY", current: { number: 7 } }), "utf8");

    const state = readWorkerStateDocument(path);
    expect(state?.worker_id).toBe("wLEGACY");
    expect(state?.current.number).toBe(7);
  });

  it("returns null for a missing or malformed document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wsd-bad-"));
    expect(readWorkerStateDocument(workerStatePath(dir))).toBeNull();
    const path = join(dir, "broken.toon");
    await writeFile(path, "{ not: valid", "utf8");
    expect(readWorkerStateDocument(path)).toBeNull();
  });
});
