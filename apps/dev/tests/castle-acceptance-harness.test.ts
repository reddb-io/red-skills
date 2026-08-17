import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import {
  acquireIssueLease,
  appendCastleHistoryRecord,
  castleLanePath,
  castleStateSnapshotPath,
  createEnginePaths,
  createFsIssueLeaseStore,
  createCastleLaneWriters,
  readCastleMonitorFleetState,
  readCastleMonitorHistoryEvents,
  readCastleMonitorWorkers,
  renderCompactDashboardToon,
  writeCastleStateSnapshot,
  type CastleStateSnapshot,
  type RawClaimComment,
  type TrackerClaimStore,
} from "@reddb-io/red-castle/engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildActivityReviewReport,
  renderActivityReviewReportToon,
} from "../src/core/activity-review.js";
import { renderStatusline } from "../src/core/statusline.js";

const NOW = Date.parse("2026-07-17T02:42:00.000Z");
const NOW_EPOCH = Math.floor(NOW / 1000);
const PROVEN_TICKET = {
  number: 1917,
  title: "Flip afk run to the castle engine",
  closedAt: "2026-07-17T02:41:16.000Z",
  evidence: "#1917",
};

class MemoryClaimStore implements TrackerClaimStore {
  private nextId = 1;
  readonly comments = new Map<number, RawClaimComment[]>();

  async postClaim(issue: number, body: string): Promise<number> {
    const id = this.nextId++;
    const rows = this.comments.get(issue) ?? [];
    rows.push({ id, body, createdAt: new Date(NOW).toISOString() });
    this.comments.set(issue, rows);
    return id;
  }

  async listClaims(issue: number): Promise<RawClaimComment[]> {
    return [...(this.comments.get(issue) ?? [])];
  }

  async concede(issue: number, body: string): Promise<void> {
    const id = this.nextId++;
    const rows = this.comments.get(issue) ?? [];
    rows.push({ id, body, createdAt: new Date(NOW).toISOString() });
    this.comments.set(issue, rows);
  }
}

function workerSnapshot(
  id: string,
  issue: number,
  over: Partial<CastleStateSnapshot> = {},
): CastleStateSnapshot {
  return {
    kind: "worker",
    id,
    worker_id: id,
    version: 1,
    updated_at: new Date(NOW).toISOString(),
    started_at: "2026-07-17T02:30:00.000Z",
    runner: "codex",
    pid: 1000,
    current: {
      origin: "afk",
      number: issue,
      title:
        issue === PROVEN_TICKET.number
          ? PROVEN_TICKET.title
          : "Acceptance harness companion ticket",
      activity: "validating",
      phase: "validating",
      loc_added: issue === PROVEN_TICKET.number ? 24 : 7,
      loc_removed: issue === PROVEN_TICKET.number ? 3 : 1,
      input_tokens: 1200,
      output_tokens: 300,
      tools_called_count: 4,
      reasoning_events: 2,
      text_chunk_count: 8,
      waiting_count: 0,
      done: issue === PROVEN_TICKET.number ? 1 : 0,
      total: 2,
    },
    queue: [issue],
    completed: issue === PROVEN_TICKET.number ? [issue] : [],
    envelope: { posted: true },
    ...over,
  };
}

describe("castle acceptance harness", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
    roots.length = 0;
  });

  it("proves the castle lanes on real ticket evidence, two-wide leases, and read surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-acceptance-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const lanes = createCastleLaneWriters(paths, {
      clock: () => new Date(NOW).toISOString(),
    });

    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", "wA1917"),
      workerSnapshot("wA1917", PROVEN_TICKET.number),
    );
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", "wB1918"),
      workerSnapshot("wB1918", 1918),
    );
    await lanes.liveness("wA1917").append({
      kind: "worker.heartbeat",
      worker_id: "wA1917",
      issue: PROVEN_TICKET.number,
      payload: { phase: "validating" },
    });
    await lanes.liveness("wB1918").append({
      kind: "worker.heartbeat",
      worker_id: "wB1918",
      issue: 1918,
      payload: { phase: "validating" },
    });
    await lanes.worker("wA1917").append({
      kind: "worker.completed",
      worker_id: "wA1917",
      issue: PROVEN_TICKET.number,
      payload: { evidence: PROVEN_TICKET.evidence },
    });
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "supervisor", "sA"),
      {
        kind: "supervisor",
        id: "sA",
        supervisor_id: "sA",
        version: 1,
        updated_at: new Date(NOW).toISOString(),
        runner: "codex",
        current: {
          epoch: NOW_EPOCH,
          ready_for_agent: 0,
          slots: { busy: 2, free: 0, total: 2, parked: 0 },
          spawns_this_tick: 2,
        },
        queue: [],
        completed: [PROVEN_TICKET.number],
      },
    );
    await appendCastleHistoryRecord(paths.castleHistory, {
      ts: new Date(NOW).toISOString(),
      epoch: NOW_EPOCH,
      worker: "wA1917",
      issue: PROVEN_TICKET.number,
      event: "done",
      duration_s: 180,
      runner: "codex",
      merge_sha: "abc1234",
      reason: PROVEN_TICKET.evidence,
    });

    const local = createFsIssueLeaseStore(join(root, "leases"));
    const remote = new MemoryClaimStore();
    const liveWorkers = new Set(["wA1917", "wB1918"]);
    const liveness = (worker: string) =>
      liveWorkers.has(worker) ? "alive" as const : "dead" as const;
    const a = await acquireIssueLease({
      issue: PROVEN_TICKET.number,
      identity: { worker: "wA1917", runner: "codex" },
      local,
      remote,
      liveness,
    });
    const b = await acquireIssueLease({
      issue: 1918,
      identity: { worker: "wB1918", runner: "codex" },
      local,
      remote,
      liveness,
    });
    const collision = await acquireIssueLease({
      issue: PROVEN_TICKET.number,
      identity: { worker: "wB1918", runner: "codex" },
      local,
      remote,
      liveness,
    });

    expect(a).toMatchObject({ verdict: "won", winner: "wA1917" });
    expect(b).toMatchObject({ verdict: "won", winner: "wB1918" });
    expect(collision).toMatchObject({
      verdict: "lost",
      winner: "wA1917",
      reason: "local lease owner is alive",
    });

    const workers = await readCastleMonitorWorkers(paths, {
      nowMs: NOW,
      kill: () => true,
    });
    const fleet = await readCastleMonitorFleetState(paths);
    const history = await readCastleMonitorHistoryEvents(paths);

    expect(workers.map((worker) => worker.state.worker_id).sort()).toEqual([
      "wA1917",
      "wB1918",
    ]);
    expect(workers.map((worker) => worker.state.current.number)).toContain(
      PROVEN_TICKET.number,
    );
    expect(fleet).toMatchObject({
      runner: "codex",
      readyForAgent: 0,
      slotsBusy: 2,
      slotsFree: 0,
      slotsTotal: 2,
      spawnsThisTick: 2,
    });
    expect(history).toEqual([{ event: "done", epoch: NOW_EPOCH }]);

    const monitor = decode(
      renderCompactDashboardToon(workers, history, NOW_EPOCH, fleet),
    ) as {
      workers: Array<{ id: string; issue: number }>;
      fleet: { slots_busy: number; slots_free: number };
      proving_drain: { drained: number; required: number; remaining: number; passed: number };
      summary: string;
    };
    expect(monitor.workers.map((worker) => worker.issue).sort()).toEqual([
      1917,
      1918,
    ]);
    expect(monitor.fleet).toMatchObject({ slots_busy: 2, slots_free: 0 });
    expect(monitor.proving_drain).toMatchObject({
      drained: 1,
      required: 20,
      remaining: 19,
      passed: 0,
    });
    expect(monitor.summary).toContain("2 workers");
    expect(monitor.summary).toContain("1 closed");
    expect(monitor.summary).toContain("proving 1/20");

    const statusline = renderStatusline({
      project: { basename: "red-skills", branch: "main" },
      fleet: { runner: "codex", busy: 2, total: 2, queue: 0, parked: 0 },
      afk: {
        workers: workers.length,
        queue: 0,
        human: 0,
        blocked: 0,
        added: workers.reduce((sum, worker) => sum + (worker.diffAdded ?? 0), 0),
        removed: workers.reduce(
          (sum, worker) => sum + (worker.diffRemoved ?? 0),
          0,
        ),
        runner: "codex",
        issues: workers.map((worker) => worker.state.current.number),
        phases: workers.map((worker) => worker.state.current.phase),
        sourceCounts: [{ origin: "afk", count: 2 }],
      },
    });
    expect(statusline).toContain("flt=codex 2/2");
    expect(statusline).toContain("wrk=2");
    expect(statusline).toContain("#1917·validating");

    const review = decode(
      renderActivityReviewReportToon(
        buildActivityReviewReport({
          kind: "daily",
          now: new Date(NOW),
          issues: [
            {
              number: PROVEN_TICKET.number,
              title: PROVEN_TICKET.title,
              state: "CLOSED",
              createdAt: "2026-07-17T02:00:00.000Z",
              closedAt: PROVEN_TICKET.closedAt,
              labels: ["spec:1900"],
              url: PROVEN_TICKET.evidence,
            },
          ],
          pullRequests: [],
          gitStats: { commits: 1, added: 1, removed: 0 },
          history: [
            {
              ts: new Date(NOW).toISOString(),
              epoch: NOW_EPOCH,
              worker: "wA1917",
              issue: PROVEN_TICKET.number,
              event: "done",
              duration_s: 180,
              runner: "codex",
              reason: PROVEN_TICKET.evidence,
            },
          ],
          activeWorkers: workers.map((worker) => ({
            worker: worker.state.worker_id,
            runner: worker.state.runner,
            issue: Number(worker.state.current.number),
            title: worker.state.current.title,
            startedAt: worker.state.started_at,
            live: worker.live,
          })),
          tokenSummary: {
            available: true,
            total: 3000,
            input: 2400,
            output: 600,
            sourceRecords: 2,
          },
        }),
      ),
    ) as {
      big_numbers: { issues_closed: number; local_workers: number };
      workers: Array<{ worker: string; issues: string; events: string }>;
      issue_cycle_times: Array<{ number: number; url: string }>;
    };
    expect(review.big_numbers).toMatchObject({
      issues_closed: 1,
      local_workers: 2,
    });
    expect(review.workers.find((worker) => worker.worker === "wA1917"))
      .toMatchObject({ issues: "#1917", events: "done:1" });
    expect(review.issue_cycle_times).toEqual([
      expect.objectContaining({
        number: PROVEN_TICKET.number,
        url: PROVEN_TICKET.evidence,
      }),
    ]);

    expect(castleLanePath(paths, "worker", "wA1917")).toContain(
      join(".red", "tmp", "workers", "wA1917", "worker.log.toonl"),
    );
  });
});
