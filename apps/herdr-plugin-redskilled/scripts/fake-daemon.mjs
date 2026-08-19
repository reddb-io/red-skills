#!/usr/bin/env node
/**
 * fake-daemon — a redskilled that lies, so the panes can be driven without one.
 *
 * The real daemon is a machine-wide singleton that owns real processes, so it is
 * the wrong thing to point at while iterating on a layout — and on a machine
 * that has never run one, there is nothing to point at at all. This speaks the
 * same frozen contract (`apps/redskilled/src/protocol.ts`) over a socket you
 * name, and **nothing it says is true**.
 *
 * It moves on its own, because a still picture exercises none of the parts that
 * break: Workers are born and die, RSS drifts, logs grow, the event lane gains
 * rows, and the pull-request count creeps up — which is what makes the log view,
 * the event view and every notification transition reachable by hand.
 *
 *   node scripts/fake-daemon.mjs --socket /tmp/redskilled-demo/redskilled.sock
 *   node scripts/fake-daemon.mjs --static      # hold the fixtures still
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

import { decodeFrame, encodeFrame, takeFrame } from "../src/redskilled/wire.mjs";
import { hostState, statuslinePayload } from "../tests/fixtures.mjs";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next == null || next.startsWith("--") ? true : next;
}

const socketPath = flag("socket", args[0] && !args[0].startsWith("--") ? args[0] : "/tmp/redskilled-demo/redskilled.sock");
const runtimeDir = dirname(socketPath);
const lanePath = join(runtimeDir, "redskilled.events.toonl");
const logDir = join(runtimeDir, "logs");
const live = flag("static", false) !== true;
const tickMs = Number(flag("tick-ms", 3_000));

mkdirSync(logDir, { recursive: true });
rmSync(socketPath, { force: true });
rmSync(lanePath, { force: true });

const LANE_FIELDS = [
  "version", "ts", "event", "worker_id", "project_label", "pid", "workspace_path",
  "log_path", "isolated", "unit", "memory_high", "memory_max", "cpu_weight",
  "detail", "exit_code", "signal",
];
let laneOpen = false;

/** One TOONL cell: quoted only when it holds something the splitter would eat. */
function cell(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/(["\\])/g, "\\$1")}"` : text;
}

function appendEvent(event) {
  if (!laneOpen) {
    appendFileSync(lanePath, `{${LANE_FIELDS.join(",")}}:\n`);
    laneOpen = true;
  }
  appendFileSync(lanePath, `  ${LANE_FIELDS.map((field) => cell(event[field])).join(",")}\n`);
}

const PROJECTS = ["reddb-io/red-skills", "reddb-io/red-dev"];
const CHATTER = [
  "claim: #%n gate-hardening: the ratchet only ever shrinks",
  "worktree: .red/tmp/workers/%w/%n/worktree",
  "gate: pnpm -C apps/plugin-dev test:invariants",
  "gate: vitest packages/worker — 412 passed",
  "WARN  toon-json-guard: 1 new JSON file I/O site",
  "landing: rebased onto origin/main, retrying",
  "ERROR push refused: non-fast-forward on origin/main",
  "ok: PR #%n opened",
];

let sequence = 0;
const started = Date.now();
const base = statuslinePayload();
const world = { workers: [], pullRequests: { "reddb-io/red-skills": 12, "reddb-io/red-dev": null }, tick: 0 };

function birth(seed = {}) {
  sequence += 1;
  const id = `w-${(sequence * 7919).toString(16).slice(0, 5)}`;
  const project = seed.project ?? PROJECTS[sequence % PROJECTS.length];
  const isolated = seed.isolated ?? sequence % 4 !== 0;
  const issue = 2900 + sequence;
  const worker = {
    worker_id: id,
    project_label: project,
    workspace_path: `/home/op/${project.split("/")[1]}/.red/tmp/workers/${id}/${issue}`,
    log_path: join(logDir, `${id}.log`),
    pid: 50_000 + sequence,
    started_at: new Date().toISOString(),
    state: "running",
    isolated,
    unit: isolated ? `redskilled-${id}.service` : null,
    warnings: isolated ? [] : ["this host afforded no transient unit; the Worker's charge lands on the daemon"],
    budgetBytes: 2 * 1024 ** 3,
    rss: 300 * 1024 ** 2 + sequence * 17 * 1024 ** 2,
    issue,
    lastLine: null,
    doomed: null,
  };
  writeFileSync(worker.log_path, "");
  world.workers.push(worker);
  appendEvent({
    version: 1,
    ts: worker.started_at,
    event: "worker-birth",
    worker_id: id,
    project_label: project,
    pid: worker.pid,
    workspace_path: worker.workspace_path,
    log_path: worker.log_path,
    isolated,
    unit: worker.unit,
    memory_high: "1500M",
    memory_max: "2G",
    cpu_weight: 100,
  });
  return worker;
}

function retire(worker, { budgetKill = false } = {}) {
  world.workers = world.workers.filter((candidate) => candidate !== worker);
  const ts = new Date().toISOString();
  const common = {
    version: 1,
    ts,
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    pid: worker.pid,
    workspace_path: worker.workspace_path,
    log_path: worker.log_path,
    isolated: worker.isolated,
    unit: worker.unit,
    memory_high: "1500M",
    memory_max: "2G",
    cpu_weight: 100,
  };
  if (budgetKill) {
    appendEvent({
      ...common,
      event: "worker-budget-kill",
      detail: `tree RSS ${(worker.rss / 1024 ** 3).toFixed(1)}G over the declared MemoryMax of 2G`,
    });
    appendEvent({ ...common, event: "worker-death", signal: "SIGKILL" });
    return;
  }
  appendEvent({ ...common, event: "worker-death", exit_code: sequence % 3 === 0 ? 1 : 0 });
}

birth({ project: PROJECTS[0], isolated: true });
birth({ project: PROJECTS[1], isolated: false });

function tick() {
  world.tick += 1;
  for (const worker of world.workers) {
    // A drift with a slow upward bias, so a Worker eventually crosses its
    // budget and the pressure notification becomes reachable by waiting.
    worker.rss = Math.max(80 * 1024 ** 2, worker.rss + (Math.random() - 0.35) * 90 * 1024 ** 2);
    const line = CHATTER[(world.tick + worker.pid) % CHATTER.length]
      .replaceAll("%n", String(worker.issue))
      .replaceAll("%w", worker.worker_id);
    worker.lastLine = line;
    appendFileSync(worker.log_path, `${new Date().toISOString()} ${line}\n`);

    if (worker.rss > worker.budgetBytes) {
      retire(worker, { budgetKill: true });
      birth();
    }
  }

  if (world.tick % 8 === 0 && world.workers.length > 1) {
    retire(world.workers[0]);
  }
  if (world.tick % 5 === 0 && world.workers.length < 4) {
    birth();
  }
  if (world.tick % 11 === 0) {
    world.pullRequests["reddb-io/red-skills"] += 1;
  }
}

function payload() {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const workers = world.workers.map((worker) => ({
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    workspace_path: worker.workspace_path,
    log_path: worker.log_path,
    pid: worker.pid,
    started_at: worker.started_at,
    uptime_ms: nowMs - Date.parse(worker.started_at),
    state: worker.state,
    isolated: worker.isolated,
    unit: worker.unit,
    warnings: worker.warnings,
    vitals: { rss_bytes: Math.round(worker.rss), sampled_at: now, age_ms: 0, fresh: true },
    budget: {
      name: "MemoryMax",
      declared: "2G",
      bytes: worker.budgetBytes,
      used_bytes: Math.round(worker.rss),
      used_fraction: worker.rss / worker.budgetBytes,
      enforceable: true,
    },
    log: worker.lastLine ? { last_line: worker.lastLine, published_at: now, source: "heartbeat" } : { last_line: null, published_at: null, source: null },
  }));

  const declared = workers.reduce((total, worker) => total + worker.budget.bytes, 0);
  const observed = workers.reduce((total, worker) => total + worker.vitals.rss_bytes, 0);
  const byProject = new Map();
  for (const worker of workers) {
    const entry = byProject.get(worker.project_label) ?? { worker_count: 0, declared_memory_bytes: 0, observed_rss_bytes: 0, measured_worker_count: 0 };
    entry.worker_count += 1;
    entry.declared_memory_bytes += worker.budget.bytes;
    entry.observed_rss_bytes += worker.vitals.rss_bytes;
    entry.measured_worker_count += 1;
    byProject.set(worker.project_label, entry);
  }

  const ceiling = base.host.ceiling;
  return {
    ...base,
    generated_at: now,
    daemon: { ...base.daemon, pid: process.pid, started_at: new Date(started).toISOString() },
    staleness: { ...base.staleness, sampled_at: now, age_ms: 0, stale: false, measured_worker_count: workers.length, unmeasured_workers: [] },
    host: {
      ...base.host,
      worker_count: workers.length,
      project_count: byProject.size,
      consumption: { worker_count: workers.length, memory_bytes: declared, unaccounted_workers: [] },
      budget_accounting: {
        ...base.host.budget_accounting,
        worker_count: workers.length,
        unisolated_workers: workers.filter((worker) => !worker.isolated).map((worker) => worker.worker_id),
      },
      observed_rss_bytes: observed,
      measured_worker_count: workers.length,
      ceiling_used_fraction: ceiling.memory_bytes ? declared / ceiling.memory_bytes : null,
    },
    projects: [...byProject.entries()].map(([project_label, entry]) => ({ project_label, ...entry })).sort((a, b) => a.project_label.localeCompare(b.project_label)),
    workers,
    repository_activity: {
      ...base.repository_activity,
      fetched_at: now,
      age_ms: 0,
      stale: false,
      projects: base.repository_activity.projects.map((project) => {
        const open = world.pullRequests[project.project_label];
        if (open == null) return { ...project, fetched_at: now, age_ms: 0 };
        return { ...project, counts: { ...project.counts, open_pull_requests: open }, fetched_at: now, age_ms: 0 };
      }),
    },
  };
}

function value(op) {
  switch (op) {
    case "ping":
      return { pong: true, protocol_version: 1, daemon_version: "0.4.1-fake", pid: process.pid };
    case "host-state":
      return { ...hostState(), pid: process.pid, workers: [], projects: [] };
    case "statusline-payload":
      return payload();
    case "statusline-string": {
      const current = payload();
      const line =
        `redskilled ${current.host.worker_count}w/${current.host.ceiling.worker_count} · ` +
        `${(current.host.observed_rss_bytes / 1024 ** 3).toFixed(1)}G · ` +
        `red-skills ${world.pullRequests["reddb-io/red-skills"]}PR · red-dev unreachable`;
      return {
        version: 1,
        line,
        lines: [line],
        mode: "global",
        project: null,
        verbose: false,
        degraded: false,
        stale: false,
        detail: "this daemon is a fake; nothing it says is true",
        generated_at: current.generated_at,
      };
    }
    case "statusline-dashboard": {
      const current = payload();
      const header =
        `» ${"reddb-io/red-skills"} v0.4.1-fake · ` +
        `wrk=${current.host.worker_count}/${current.host.worker_count} · ` +
        `mem=${(current.host.observed_rss_bytes / 1024 ** 3).toFixed(1)}G · ` +
        `prs=${world.pullRequests["reddb-io/red-skills"]}`;
      const rows = current.workers.map((worker) => ({
        worker_id: worker.worker_id,
        project_label: worker.project_label,
        mine: false,
        cells: {},
        line: `${worker.worker_id}  run=fake  org=afk  hb=?`,
      }));
      return {
        version: 1,
        generated_at: current.generated_at,
        mode: "global",
        project: null,
        columns: ["wid", "run", "org", "iss", "bar", "phase", "elapsed", "hb", "loc", "tks", "tls", "rsn", "txt"],
        header: {
          repo: "reddb-io/red-skills",
          project: null,
          project_match: "unresolved",
          version: "0.4.1-fake",
          model: null,
          windows: {
            memory_used_fraction: null,
            memory_used_bytes: current.host.observed_rss_bytes,
            memory_ceiling_bytes: current.host.ceiling.memory_bytes,
            worker_count: current.host.worker_count,
            worker_ceiling: current.host.ceiling.worker_count,
          },
          counts: {
            open_pull_requests: world.pullRequests["reddb-io/red-skills"],
            recently_closed: null,
            open_issues: null,
            stale: false,
          },
          stale: false,
          age_ms: 0,
          line: header,
        },
        rows,
        lines: [header, ...rows.map((row) => row.line)],
        hidden_row_count: 0,
        stale: false,
      };
    }
    default:
      return null;
  }
}

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let framed = takeFrame(buffer); framed; framed = takeFrame(buffer)) {
      buffer = framed.rest;
      let request;
      try {
        request = decodeFrame(framed.frame);
      } catch {
        // A frame this fake cannot read is dropped rather than answered: the real
        // daemon replies with a fresh id so a client can tell "not understood"
        // from "refused", and a fake that guessed an id would teach the opposite.
        continue;
      }
      const answer = value(request.op);
      socket.write(
        encodeFrame(
          answer == null
            ? { id: request.id, ok: false, error: `this fake daemon does not serve ${request.op}` }
            : { id: request.id, ok: true, value: answer },
        ),
      );
    }
  });
  socket.on("error", () => {});
});

server.listen(socketPath, () => {
  process.stderr.write(
    `fake redskilled on ${socketPath}\n` +
      `  event lane  ${lanePath}\n` +
      `  worker logs ${logDir}\n` +
      `  ${live ? `moving every ${tickMs}ms` : "held still (--static)"}\n`,
  );
});

const timer = live ? setInterval(tick, tickMs) : null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (timer) clearInterval(timer);
    server.close();
    rmSync(socketPath, { force: true });
    process.exit(0);
  });
}
