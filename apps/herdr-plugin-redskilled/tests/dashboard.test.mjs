import assert from "node:assert/strict";
import test from "node:test";

import { stripAnsi } from "../src/ui/ansi.mjs";
import {
  renderActivity,
  renderDashboard,
  renderHost,
  renderMetrics,
  renderProjects,
  renderWorkerRow,
  renderWorkers,
  shortProject,
} from "../src/ui/dashboard.mjs";
import { renderEventRow, renderLogView, workerLogSubtitle } from "../src/ui/logs.mjs";
import { snapshot, statuslinePayload } from "./fixtures.mjs";

const SIZE = { columns: 120, rows: 40 };

function text(lines) {
  return lines.map(stripAnsi).join("\n");
}

test("no frame is ever wider than the pane", () => {
  const lines = renderDashboard({ snapshot: snapshot(), state: state(), size: { columns: 64, rows: 30 } });
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 64, `line overflows the pane: ${JSON.stringify(stripAnsi(line))}`);
  }
});

function state(overrides = {}) {
  return { view: "overview", mode: "global", verbose: true, selected: 0, message: null, ...overrides };
}

test("the host row states the ceiling it was given, and the fraction with it", () => {
  const rendered = text(renderHost(statuslinePayload(), SIZE));
  assert.match(rendered, /2 workers/);
  assert.match(rendered, /2 projects/);
  assert.match(rendered, /slots 2\/6/);
  assert.match(rendered, /3\.00G\/8\.00G/);
  assert.match(rendered, /38%|37%/);
  assert.match(rendered, /1 unisolated/);
});

test("repair activity names its lane, patient and step from the display record", () => {
  const payload = statuslinePayload();
  payload.workers[0].display = {
    origin: "repair",
    issue: "3291",
    phase: "merging",
    step: "regenerate",
  };
  payload.workers[1].display = { origin: "afk" };

  const host = text(renderHost(payload, SIZE));
  const row = text(renderWorkerRow(payload.workers[0], {
    columns: 120,
    selected: false,
    verbose: false,
    localProject: null,
  }));

  assert.match(host, /1 coding \+ 1 repairing/);
  assert.match(row, /repair lane/);
  assert.match(row, /PR #3291/);
  assert.match(row, /regenerate/);
  assert.doesNotMatch(text(renderHost(statuslinePayload(), SIZE)), /repairing/);
});

test("a host with no ceiling says so instead of drawing a full bar", () => {
  const payload = statuslinePayload();
  payload.host.ceiling = { memory_bytes: null, worker_count: null, source: "declared" };
  payload.host.ceiling_used_fraction = null;
  const rendered = text(renderHost(payload, SIZE));
  assert.match(rendered, /no ceiling/);
  assert.match(rendered, /slots ∞/);
});

test("an unmeasured Worker reads as unmeasured, never as idle", () => {
  const payload = statuslinePayload();
  const idle = payload.workers[1];
  const rendered = text(renderWorkerRow(idle, { columns: 120, selected: false, verbose: true, localProject: null }));
  assert.match(rendered, /—\/—/, "an unmeasured Worker carries a dash where its RSS would be");
  assert.match(rendered, /\s—\s/, "and a dash where its share of the budget would be");
  assert.match(rendered, /no unit/);
  assert.ok(!/\b0B\b/.test(rendered), "an absence must not be rendered as a zero");
  assert.ok(!/\b0%/.test(rendered), "nor as a zero share");
});

test("a Worker's published line is shown under its row, and only when there is one", () => {
  const payload = statuslinePayload();
  const busy = text(renderWorkerRow(payload.workers[0], { columns: 120, selected: true, verbose: true, localProject: null }));
  assert.match(busy, /vitest packages\/worker/);

  const quiet = renderWorkerRow(payload.workers[1], { columns: 120, selected: false, verbose: true, localProject: null });
  assert.equal(quiet.length, 1, "a Worker that published nothing gets no second line at all");
});

test("a narrow pane keeps the vitals and gives up the identity columns", () => {
  const rendered = text(
    renderWorkers(statuslinePayload(), { columns: 80, selected: 0, verbose: false, localProject: null, budgetRows: 10 }),
  );
  assert.match(rendered, /44%/, "the budget share is the cell this pane exists for");
  assert.match(rendered, /red-skills/);
  assert.match(rendered, /red-dev/);
  assert.ok(!/reddb-io\/re…/.test(rendered), "two repositories of one owner must not truncate to the same string");
});

test("shortProject drops the owner rather than the repository", () => {
  assert.equal(shortProject("reddb-io/red-skills", 30), "reddb-io/red-skills");
  assert.equal(shortProject("reddb-io/red-skills", 12), "red-skills");
  assert.equal(shortProject("standalone", 4), "standalone");
});

test("an idle host says it is idle rather than drawing an empty table", () => {
  const payload = statuslinePayload();
  payload.workers = [];
  const rendered = text(renderWorkers(payload, { columns: 120, selected: 0, verbose: true, localProject: null, budgetRows: 10 }));
  assert.match(rendered, /no Workers on this host/);
});

test("a table that does not fit says how much it dropped", () => {
  const payload = statuslinePayload();
  const rendered = text(renderWorkers(payload, { columns: 120, selected: 0, verbose: false, localProject: null, budgetRows: 1 }));
  assert.match(rendered, /1 more Worker\(s\)/);
});

test("the metrics section draws the daemon's rates and shares, per window", () => {
  const rendered = text(renderMetrics(statuslinePayload(), SIZE));
  assert.match(rendered, /METRICS/);
  assert.match(rendered, /1h\s+1\.2k\s+8\.4/, "the hour's rates come from the daemon, rounded for the pane");
  assert.match(rendered, /24h\s+820\s+5\.1\s+0\.2/, "and the day's beside them");
  assert.match(rendered, /runner\s+claude 67% \(2\) · codex 33% \(1\)/);
  assert.match(rendered, /model\s+opus 50% \(1\) · sonnet 50% \(1\)/);
  assert.match(rendered, /3 unattributed/, "a Worker nobody attributed is counted, never dropped");
});

test("a window that measured nothing draws a dash and the reason, never a zero", () => {
  const rendered = text(renderMetrics(statuslinePayload(), SIZE));
  const hour = rendered.split("\n").find((line) => /^\s+1h\s/.test(line));
  assert.match(hour, /—/, "the hour finished no issue, so its rate is a dash");
  assert.ok(!/\s0\s*$/.test(hour), "an absence must not be rendered as a zero");
  assert.match(rendered, /no Worker published a model in the last 1h/);
  assert.match(rendered, /worker-outcomes/, "the source that had nothing to answer with is named");
});

test("a daemon carrying no metrics block says so instead of drawing zeros", () => {
  const payload = statuslinePayload();
  delete payload.metrics;
  const rendered = text(renderMetrics(payload, SIZE));
  assert.match(rendered, /derives no metrics/);
  assert.ok(!/tokens\/min/.test(rendered), "an absent block draws no table at all");
});

test("a project with a registration and no Worker is still a project", () => {
  const payload = statuslinePayload();
  payload.projects = [];
  const rendered = text(
    renderProjects(payload, { registrations: [{ project_label: "reddb-io/quiet", target: 2, renewal: "renewing" }] }, {
      columns: 120,
      localProject: null,
      budgetRows: 10,
    }),
  );
  assert.match(rendered, /reddb-io\/quiet/);
  assert.match(rendered, /renewing · target 2/);
});

test("a host that knows a project but holds no Worker says which", () => {
  const payload = statuslinePayload();
  payload.projects = [];
  const rendered = text(renderProjects(payload, { registrations: [] }, { columns: 120, localProject: null, budgetRows: 10 }));
  assert.match(rendered, /this host knows 3 project\(s\)/);
});

test("an unreachable repository shows no counts rather than zero counts", () => {
  const rendered = text(renderActivity(statuslinePayload(), { columns: 120, localProject: null, budgetRows: 10 }));
  assert.match(rendered, /reddb-io\/red-skills\s+12\s+48\s+31/);
  assert.match(rendered, /unreachable/);
  assert.match(rendered, /quota 4832 left/);
  const dev = rendered.split("\n").find((line) => line.includes("red-dev"));
  assert.match(dev, /—\s+—\s+—/, "an unreachable repository carries dashes, never zeros");
});

test("a spent quota is named, so an empty tracker cannot pass for a spent one", () => {
  const payload = statuslinePayload();
  payload.repository_activity.rate_limit = { remaining: 0, reset_at: "2026-07-31T13:02:00.000Z", exhausted: true };
  payload.repository_activity.projects[0] = {
    ...payload.repository_activity.projects[0],
    outcome: "rate-limited",
    counts: null,
  };
  const rendered = text(renderActivity(payload, { columns: 120, localProject: null, budgetRows: 10 }));
  assert.match(rendered, /rate-limited/);
  assert.match(rendered, /quota spent/);
});

test("an unreachable daemon draws an absence, not a host of zeros", () => {
  const down = snapshot({ reachable: false, payload: null, hostState: null, error: { message: "redskilled is not reachable at /run/x.sock" } });
  const rendered = text(
    renderDashboard({
      snapshot: down,
      state: state(),
      size: SIZE,
      socket: { socketPath: "/run/x.sock", source: "derived from XDG_RUNTIME_DIR" },
    }),
  );
  assert.match(rendered, /no host answered/);
  assert.match(rendered, /\/run\/x\.sock/);
  assert.match(rendered, /derived from XDG_RUNTIME_DIR/);
  assert.ok(!/0 workers/.test(rendered), "an unreachable daemon must never be rendered as an idle one");
});

test("a held major is reported rather than passing for current", () => {
  const held = snapshot();
  held.hostState.upgrade = {
    ...held.hostState.upgrade,
    major_held: 1,
    major_hold: { version: "1.0.0", running_major: 0, held_major: 1, reason: "breaking", action: "re-point the unit" },
  };
  const rendered = text(renderDashboard({ snapshot: held, state: state(), size: SIZE }));
  assert.match(rendered, /held at major 1/);
  assert.match(rendered, /re-point the unit/);
});

test("a posed death is drawn with its attribution, so the pane answers why it died", () => {
  const rendered = text(renderDashboard({ snapshot: snapshot(), state: state(), size: SIZE }));
  assert.match(rendered, /worker worker:w-gone/);
  assert.match(rendered, /oomd\/high/);
  assert.match(rendered, /phase coding/);
  assert.match(rendered, /signal SIGKILL/);
  assert.match(rendered, /systemd-oomd killed/);
});

test("an honest ignorance is drawn as one, never dressed up as a cause", () => {
  const rendered = text(renderDashboard({ snapshot: snapshot(), state: state(), size: SIZE }));
  assert.match(rendered, /launcher launcher:1701/);
  assert.match(rendered, /unknown\/none/);
});

test("a machine where nothing died spends no line saying so", () => {
  const quiet = snapshot();
  quiet.payload.deaths = { count: 0, recent: [], latest: null, reaped_at: null };
  const rendered = text(renderDashboard({ snapshot: quiet, state: state(), size: SIZE }));
  assert.ok(!/†/.test(rendered), "an empty reaping must not render a badge");
});

test("the engine version comes from the payload, so one read answers it", () => {
  const skewed = snapshot();
  skewed.hostState = null;
  skewed.payload.engine = {
    running_version: "0.4.1",
    published_version: "0.5.0",
    newer_published: true,
    major_held: false,
    current: false,
  };
  const rendered = text(renderDashboard({ snapshot: skewed, state: state(), size: SIZE }));
  assert.match(rendered, /redskilled 0\.4\.1/);
  assert.match(rendered, /upgrade pending 0\.4\.1 → 0\.5\.0/);
});

test("a stale payload renders the daemon's own reason", () => {
  const stale = snapshot();
  stale.payload.staleness = { ...stale.payload.staleness, stale: true, reason: "this answer is stale: 91000ms old" };
  const rendered = text(renderDashboard({ snapshot: stale, state: state(), size: SIZE }));
  assert.match(rendered, /stale/);
  assert.match(rendered, /91000ms old/);
});

test("the help view answers where the numbers come from", () => {
  const rendered = text(renderDashboard({ snapshot: snapshot(), state: state({ view: "help" }), size: SIZE }));
  assert.match(rendered, /host-state/);
  assert.match(rendered, /statusline-payload/);
  assert.match(rendered, /never writes/);
});

test("a log view fills the pane and says whether it is following", () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  const frame = renderLogView({
    title: "worker log",
    subtitle: "w-1",
    lines,
    offset: 0,
    follow: true,
    size: { columns: 60, rows: 12 },
    empty: "nothing yet",
  });
  assert.equal(frame.length, 12);
  assert.match(text(frame), /● following/);
  assert.match(text(frame), /line 199/);

  const scrolled = renderLogView({
    title: "worker log",
    subtitle: "w-1",
    lines,
    offset: 50,
    follow: false,
    size: { columns: 60, rows: 12 },
    empty: "nothing yet",
  });
  assert.match(text(scrolled), /▲ paused/);
  assert.ok(!text(scrolled).includes("line 199"));
});

test("a Worker with no declared log path says so instead of guessing one", () => {
  const worker = statuslinePayload().workers[1];
  const subtitle = stripAnsi(workerLogSubtitle(worker, { exists: false, path: null }));
  assert.match(subtitle, /no readable log|no log path/);
});

test("an event row states how a Worker ended", () => {
  const columns = 120;
  assert.match(
    stripAnsi(renderEventRow({ ts: "2026-07-31T12:00:00.000Z", event: "worker-death", worker_id: "w-1", project_label: "p", exit_code: 0 }, { columns })),
    /death\s+w-1\s+p\s+exit 0/,
  );
  assert.match(
    stripAnsi(renderEventRow({ ts: "2026-07-31T12:00:00.000Z", event: "worker-budget-kill", worker_id: "w-2", project_label: "p", detail: "over MemoryMax" }, { columns })),
    /budget-kill.*over MemoryMax/,
  );
  assert.match(
    stripAnsi(renderEventRow({ ts: "2026-07-31T12:00:00.000Z", event: "worker-death", worker_id: "w-3", project_label: "p", exit_code: null }, { columns })),
    /exit —/,
  );
});
