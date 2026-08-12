// A display a Worker PUBLISHES is a display the surfaces READ (#3144).
//
// Every link in this chain read correct in isolation and the chain was silent:
// the castle bridge built the record, the client sent it on the beat, the daemon
// stored it — and the render read never named the `display` extra, so the daemon
// withheld it exactly as it is designed to. Four surfaces drew a UUID and an age
// while runner, model, effort, issue, phase and the progress bar sat unasked.
//
// `display-is-asked-for.test.ts` pins the ONE line that broke, at the source. This
// pins the WHOLE chain, over a real socket, so a future break at any other link —
// a daemon that stops storing, a payload that stops carrying, a withholding rule
// that widens — fails here rather than in a screenshot weeks later.
//
// Driven from a fixture rather than from a live Worker on purpose: a host whose
// installed plugin is behind publishes nothing at all, and a regression test that
// only passes on a freshly-updated machine is a test nobody trusts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "@reddb-io/redskilled-render";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  publishRedskilledWorkerLogLine,
  readRedskilledDashboardRender,
  readRedskilledStatuslinePayload,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { REDSKILLED_WORKER_DISPLAY_ABSENT, type RedskilledWorkerDisplay } from "../src/worker-display.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PROJECT = "acme/widgets";
const NOW = "2026-08-03T12:10:00.000Z";

const VIEW: RedskilledWorkerView = {
  worker_id: "w-display",
  project_label: PROJECT,
  pid: 4242,
  started_at: "2026-08-03T12:00:00.000Z",
  workspace_path: "/tmp/acme/w-display",
  isolated: true,
  warnings: [],
};

/** Everything a project publishes about a Worker mid-pipeline. */
const PUBLISHED: RedskilledWorkerDisplay = {
  ...REDSKILLED_WORKER_DISPLAY_ABSENT,
  runner: "claude",
  model: "claude-opus-4-8",
  effort: "high",
  origin: "afk",
  issue: "3144",
  phase: "coding",
  step: "testing",
  phase_index: 2,
  phase_total: 5,
  heartbeat: "3s",
  started_at: "2026-08-03T12:00:00.000Z",
  phase_started_at: "2026-08-03T12:05:00.000Z",
  progress_at: "2026-08-03T12:08:00.000Z",
  tokens: 4200,
  tools: 12,
};

/** A daemon with one tracked Worker, and the paths to reach it. */
async function hostWithOneWorker(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-display-"));
  roots.push(root);
  const paths = resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
  const daemon = await startRedskilledDaemon({
    paths,
    idleMs: 60_000,
    sampleMs: 0,
    ceiling: UNBOUNDED_HOST_CEILING,
    stopWorker: () => true,
    clock: () => NOW,
  });
  running.push(daemon);
  daemon.trackWorker(VIEW);
  return paths;
}

async function publish(paths: RedskilledPaths): Promise<void> {
  const ack = await publishRedskilledWorkerLogLine(paths, {
    worker_id: VIEW.worker_id,
    line: "running the gate",
    display: PUBLISHED,
    session_project: PROJECT,
  });
  expect(ack.accepted, ack.detail).toBe(true);
}

describe("a published display reaches the payload", () => {
  it("carries every field the project published, when the read asks for it", async () => {
    const paths = await hostWithOneWorker();
    await publish(paths);

    const payload = await readRedskilledStatuslinePayload(
      paths,
      { sessionProject: PROJECT },
      { logs: true, vitals: true, display: true },
    );

    const worker = payload.workers.find((candidate) => candidate.worker_id === VIEW.worker_id);
    expect(worker, "the daemon lost the Worker it is tracking").toBeDefined();
    // Field by field rather than by shape: the bug was a whole record missing, and
    // a `toBeDefined` would have passed on a record holding nothing but nulls.
    expect(worker?.display).toMatchObject({
      runner: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      origin: "afk",
      issue: "3144",
      phase: "coding",
      step: "testing",
      phase_index: 2,
      phase_total: 5,
      heartbeat: "3s",
      started_at: "2026-08-03T12:00:00.000Z",
      phase_started_at: "2026-08-03T12:05:00.000Z",
      progress_at: "2026-08-03T12:08:00.000Z",
      tokens: 4200,
      tools: 12,
    });
    // Stored BESIDE the log line, on the same beat and the same daemon instant.
    expect(worker?.display_published_at).toBe(NOW);
    expect(worker?.log.last_line).toBe("running the gate");
    expect(payload.withheld ?? []).toEqual([]);
  });

  it("carries it for a reader that names no extras at all", async () => {
    // The compatibility spelling: a bundle pinned before ADR 0132 decision 2 asks
    // for everything by saying nothing, and must not be the one reader that lost
    // the display when the extras were introduced.
    const paths = await hostWithOneWorker();
    await publish(paths);

    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: PROJECT });

    expect(payload.workers[0]?.display?.issue).toBe("3144");
    expect(payload.workers[0]?.display_published_at).toBe(NOW);
  });

  it("withholds it from a read that names the other two — the shape of the break", async () => {
    // Not a wish, a mechanism: naming extras EXCLUDES the unnamed ones, which is
    // why two correct-looking lines (`logs: true, vitals: true`) silenced a record
    // built, sent and stored. A test that only asserted the cure would pass again
    // the day the cure is reverted to a subset.
    const paths = await hostWithOneWorker();
    await publish(paths);

    const payload = await readRedskilledStatuslinePayload(
      paths,
      { sessionProject: PROJECT },
      { logs: true, vitals: true },
    );

    expect(payload.workers[0]?.display).toBeNull();
    expect(payload.workers[0]?.display_published_at).toBeNull();
    expect(payload.withheld).toEqual(["display"]);
  });

  it("reaches the dashboard the surfaces draw, as issue, run, phase and a bar", async () => {
    const paths = await hostWithOneWorker();
    await publish(paths);

    const dashboard = await readRedskilledDashboardRender(paths, { project: PROJECT, maxWidth: 300 }, {
      sessionProject: PROJECT,
    });

    const row = dashboard.rows.find((candidate) => candidate.worker_id === VIEW.worker_id);
    expect(row, "the dashboard drew no row for a Worker the daemon tracks").toBeDefined();
    expect(row?.cells.iss).toBe("iss=3144");
    expect(row?.cells.run).toBe("run=claude opus-4.8 high");
    expect(row?.cells.org).toBe("org=afk");
    expect(row?.cells.phase).toBe("coding 3/5 · testing");
    // Two behind, one cursor, two ahead — the bar the daemon never has to name.
    expect(row?.cells.bar).toBe("██▶░░");
    expect(row?.cells.hb).toBe("hb=3s");
    // And the row a reader actually sees is the one that carried a UUID and an age.
    expect(stripAnsi(row?.line ?? "")).toContain("iss=3144");
    expect(row?.line).toContain("coding 3/5 · testing");
  });

  it("draws the honest empty row for a Worker that published nothing", async () => {
    // The opposite fact, pinned beside it: absent must stay absent rather than
    // become a zero, or the cure would make an unmeasured Worker look measured.
    const paths = await hostWithOneWorker();

    const dashboard = await readRedskilledDashboardRender(paths, { project: PROJECT, maxWidth: 300 }, {
      sessionProject: PROJECT,
    });

    const row = dashboard.rows.find((candidate) => candidate.worker_id === VIEW.worker_id);
    expect(row?.cells.iss).toBe("");
    expect(row?.cells.bar).toBe("");
    expect(row?.cells.tks).toBe("");
    expect(row?.cells.hb).toBe("hb=?");
  });
});
