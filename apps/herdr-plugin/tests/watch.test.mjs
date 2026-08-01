import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.mjs";
import { detectSignals, snapshotState, throttle } from "../src/watch/signals.mjs";
import { chooseWorker } from "../src/commands/logs.mjs";
import { entrypointFor } from "../src/commands/pane.mjs";
import { cwdFromContext } from "../src/herdr.mjs";
import { parseArgs } from "../bin/red-skills-herdr.mjs";
import { snapshot } from "./fixtures.mjs";

const NOW = "2026-07-31T12:00:00.000Z";
const config = { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications, workerBirth: true } };

function kinds(signals) {
  return signals.map((signal) => signal.kind);
}

test("a first read announces nothing that has not changed", () => {
  const current = snapshotState(snapshot());
  const signals = detectSignals({ previous: null, current, snapshot: snapshot(), config, now: NOW });
  assert.deepEqual(signals, [], "session restore must not open with a wall of unchanged facts");
});

test("a first read against a dead daemon says so once", () => {
  const down = { reachable: false, payload: null, hostState: null, error: { message: "nothing answered" } };
  const signals = detectSignals({ previous: null, current: snapshotState(down), snapshot: down, config, now: NOW });
  assert.deepEqual(kinds(signals), ["daemon-reach"]);
});

test("reachability is a transition in both directions", () => {
  const up = snapshotState(snapshot());
  const down = snapshotState({ reachable: false });
  assert.deepEqual(kinds(detectSignals({ previous: up, current: down, snapshot: { error: { message: "gone" } }, config, now: NOW })), [
    "daemon-reach",
  ]);
  assert.deepEqual(kinds(detectSignals({ previous: down, current: up, snapshot: snapshot(), config, now: NOW })), ["daemon-reach"]);
});

test("coming back is a fresh baseline, not a burst of births", () => {
  const down = snapshotState({ reachable: false });
  const up = snapshot();
  const signals = detectSignals({ previous: down, current: snapshotState(up), snapshot: up, config, now: NOW });
  assert.deepEqual(kinds(signals), ["daemon-reach"], "an outage must not end in one notification per live Worker");
});

test("a new pid holding the same Workers is a restart, not an evacuation", () => {
  const previous = snapshotState(snapshot());
  const moved = snapshot();
  moved.payload.daemon = { ...moved.payload.daemon, pid: 9999 };
  const signals = detectSignals({ previous, current: snapshotState(moved), snapshot: moved, config, now: NOW });
  assert.deepEqual(kinds(signals), ["daemon-reach"]);
  assert.match(signals[0].title, /restarted/);
});

test("the event lane decides how a Worker ended, not the set difference", () => {
  const previous = snapshotState(snapshot());
  const after = snapshot();
  after.payload.workers = after.payload.workers.filter((worker) => worker.worker_id !== "w-2f91a");
  const events = [
    { ts: "2026-07-31T11:59:59.000Z", event: "worker-death", worker_id: "w-2f91a", project_label: "reddb-io/red-skills", exit_code: 1 },
  ];
  const signals = detectSignals({ previous, current: snapshotState(after, { events }), snapshot: after, events, config, now: NOW });
  const death = signals.find((signal) => signal.kind === "worker-death");
  assert.ok(death, "a Worker that ended is news");
  assert.match(death.body, /exit 1/);
  assert.equal(signals.filter((signal) => signal.kind === "worker-death").length, 1, "the lane and the set diff must not both fire");
});

test("a Worker that vanishes with no lane record is reported without inventing an exit", () => {
  const previous = snapshotState(snapshot());
  const after = snapshot();
  after.payload.workers = after.payload.workers.filter((worker) => worker.worker_id !== "w-2f91a");
  const signals = detectSignals({ previous, current: snapshotState(after), snapshot: after, events: [], config, now: NOW });
  const death = signals.find((signal) => signal.kind === "worker-death");
  assert.match(death.body, /did not say how it ended/);
});

test("a budget kill is its own signal, louder than an ordinary death", () => {
  const previous = snapshotState(snapshot());
  const events = [
    { ts: "2026-07-31T11:59:59.000Z", event: "worker-budget-kill", worker_id: "w-2f91a", project_label: "p", detail: "over MemoryMax" },
  ];
  const after = snapshot();
  after.payload.workers = [];
  const signals = detectSignals({ previous, current: snapshotState(after, { events }), snapshot: after, events, config, now: NOW });
  assert.ok(kinds(signals).includes("worker-budget-kill"));
});

test("budget pressure fires on crossing the threshold, and not again above it", () => {
  const before = snapshot();
  before.payload.workers[0].budget.used_fraction = 0.5;
  const crossing = snapshot();
  crossing.payload.workers[0].budget.used_fraction = 0.95;
  const higher = snapshot();
  higher.payload.workers[0].budget.used_fraction = 0.97;

  const first = detectSignals({
    previous: snapshotState(before),
    current: snapshotState(crossing),
    snapshot: crossing,
    config,
    now: NOW,
  });
  assert.ok(kinds(first).includes("budget-pressure"));

  const second = detectSignals({
    previous: snapshotState(crossing),
    current: snapshotState(higher),
    snapshot: higher,
    config,
    now: NOW,
  });
  assert.ok(!kinds(second).includes("budget-pressure"), "staying over the line is a state, not a transition");
});

test("only an increase in open pull requests is news", () => {
  const before = snapshot();
  const more = snapshot();
  more.payload.repository_activity.projects[0].counts.open_pull_requests = 14;
  const fewer = snapshot();
  fewer.payload.repository_activity.projects[0].counts.open_pull_requests = 9;

  const up = detectSignals({ previous: snapshotState(before), current: snapshotState(more), snapshot: more, config, now: NOW });
  assert.ok(kinds(up).includes("pull-requests"));
  assert.match(up.find((signal) => signal.kind === "pull-requests").title, /14 open PRs/);

  const down = detectSignals({ previous: snapshotState(before), current: snapshotState(fewer), snapshot: fewer, config, now: NOW });
  assert.ok(!kinds(down).includes("pull-requests"));
});

test("an unreachable repository never becomes a pull-request count", () => {
  const before = snapshot();
  const current = snapshotState(before);
  assert.ok(!("reddb-io/red-dev" in current.pullRequests), "a repository with no counts contributes none");
});

test("a disabled signal is not emitted", () => {
  const quiet = { ...config, notifications: { ...config.notifications, pullRequests: false } };
  const before = snapshot();
  const more = snapshot();
  more.payload.repository_activity.projects[0].counts.open_pull_requests = 20;
  const signals = detectSignals({ previous: snapshotState(before), current: snapshotState(more), snapshot: more, config: quiet, now: NOW });
  assert.ok(!kinds(signals).includes("pull-requests"));
});

test("throttle keeps one signal per key inside the renotify window", () => {
  const signal = { kind: "worker-death", key: "worker-death:w-1", title: "t", body: "b" };
  const first = throttle([signal], {}, { renotifyMs: 60_000, now: "2026-07-31T12:00:00.000Z" });
  assert.equal(first.signals.length, 1);

  const again = throttle([signal], first.sentAt, { renotifyMs: 60_000, now: "2026-07-31T12:00:30.000Z" });
  assert.equal(again.signals.length, 0);

  const later = throttle([signal], first.sentAt, { renotifyMs: 60_000, now: "2026-07-31T12:02:00.000Z" });
  assert.equal(later.signals.length, 1);
});

test("chooseWorker prefers the explicit id, then the newest of a project", () => {
  const workers = [
    { worker_id: "old", project_label: "a", started_at: "2026-07-31T10:00:00.000Z" },
    { worker_id: "new", project_label: "a", started_at: "2026-07-31T11:00:00.000Z" },
    { worker_id: "other", project_label: "b", started_at: "2026-07-31T11:30:00.000Z" },
  ];
  assert.equal(chooseWorker(workers, { workerId: "old" }).worker_id, "old");
  assert.equal(chooseWorker(workers, { project: "a" }).worker_id, "new");
  assert.equal(chooseWorker(workers, {}).worker_id, "other");
  assert.equal(chooseWorker([], {}), null);
  assert.equal(chooseWorker(workers, { workerId: "missing" }), null);
});

test("the invocation cwd is read from the context, never from this process", () => {
  // herdr runs a runtime command with the PLUGIN directory as its cwd, so an
  // action that used `process.cwd()` would open every pane against this
  // checkout and report the plugin as the local project.
  assert.equal(cwdFromContext({ pane: { cwd: "/home/op/red-skills" } }), "/home/op/red-skills");
  assert.equal(cwdFromContext({ pane: { foreground_cwd: "/home/op/deep" } }), "/home/op/deep");
  assert.equal(cwdFromContext({ focused_pane: { cwd: "/home/op/focused" } }), "/home/op/focused");
  assert.equal(cwdFromContext({ worktree: { path: "/home/op/wt" } }), "/home/op/wt");
  assert.equal(cwdFromContext({ pane: { cwd: "   " }, cwd: "/home/op/fallback" }), "/home/op/fallback");
  assert.equal(cwdFromContext({}), null, "an unknown cwd is left unstated, so herdr picks its own default");
  assert.equal(cwdFromContext(undefined), null);
});

test("the windows twin of an entrypoint is the one windows runs", () => {
  assert.equal(entrypointFor("dashboard", "linux"), "dashboard");
  assert.equal(entrypointFor("dashboard", "darwin"), "dashboard");
  assert.equal(entrypointFor("dashboard", "win32"), "dashboard-windows");
});

test("argv parses the flags every command shares", () => {
  assert.deepEqual(parseArgs(["dashboard", "--mode", "local", "--refresh-ms", "500", "--verbose"]), {
    command: "dashboard",
    positional: [],
    flags: { mode: "local", refreshMs: 500, verbose: true },
  });
  assert.deepEqual(parseArgs(["pane", "toggle", "logs", "--no-focus"]), {
    command: "pane",
    positional: ["toggle", "logs"],
    flags: { focus: false },
  });
  assert.deepEqual(parseArgs(["status", "--socket=/tmp/x.sock", "--json"]), {
    command: "status",
    positional: [],
    flags: { socket: "/tmp/x.sock", json: true },
  });
  assert.equal(parseArgs(["-v"]).flags.version, true);
  assert.equal(parseArgs(["-h"]).flags.help, true);
});
