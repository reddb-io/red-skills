/**
 * dashboard — the pane an operator leaves open.
 *
 * One process, three views: the overview, one Worker's log, and the host event
 * lane. They live in the same pane rather than in three because the question an
 * operator actually asks is one question — "what is this machine doing, and why
 * did that Worker stop" — and answering it should not cost two pane spawns and a
 * hunt for which split holds which.
 */
import { createRedskilledClient, readRedskilledSnapshot } from "../redskilled/client.mjs";
import { readEventLane } from "../redskilled/event-lane.mjs";
import { tailFile } from "../redskilled/log-tail.mjs";
import { resolveRedskilledPaths } from "../redskilled/paths.mjs";
import { resolveProjectLabel } from "../redskilled/project-identity.mjs";
import { notify } from "../herdr.mjs";
import { renderDashboard } from "../ui/dashboard.mjs";
import { colourLogLine, renderEventRow, renderLogView, workerLogSubtitle } from "../ui/logs.mjs";
import { runScreen } from "../ui/screen.mjs";

export async function runDashboard({ config, flags = {} }) {
  const socket = resolveRedskilledPaths({ socketPath: flags.socket ?? config.socketPath });
  const client = createRedskilledClient({ socketPath: socket.socketPath, timeoutMs: config.timeoutMs });
  const localProject = await resolveProjectLabel(process.cwd()).catch(() => null);

  const state = {
    view: "overview",
    mode: flags.mode ?? config.mode,
    verbose: flags.verbose ?? config.verbose,
    selected: 0,
    message: null,
    logOffset: 0,
    follow: true,
    logWorkerId: null,
  };

  let snapshot = { reachable: false, payload: null, hostState: null, error: null };
  let logTail = { lines: [], exists: false };
  let events = { records: [], exists: false };

  function workers() {
    return snapshot.payload?.workers ?? [];
  }

  function selectedWorker() {
    const list = workers();
    if (list.length === 0) return null;
    return list[Math.min(state.selected, list.length - 1)] ?? null;
  }

  async function refresh() {
    snapshot = await readRedskilledSnapshot(client, {
      sessionProject: state.mode === "local" ? localProject ?? undefined : undefined,
    });
    const list = workers();
    if (state.selected >= list.length) state.selected = Math.max(0, list.length - 1);

    if (state.view === "logs") {
      const worker = state.logWorkerId
        ? list.find((candidate) => candidate.worker_id === state.logWorkerId) ?? null
        : selectedWorker();
      logTail = await tailFile(worker?.log_path).catch((error) => ({ lines: [], exists: false, reason: error.message }));
    }
    if (state.view === "events") {
      events = await readEventLane(socket.eventLanePath).catch(() => ({ records: [], exists: false }));
    }
  }

  function render(size) {
    if (state.view === "logs") {
      const worker = state.logWorkerId
        ? workers().find((candidate) => candidate.worker_id === state.logWorkerId) ?? null
        : selectedWorker();
      return renderLogView({
        title: "worker log",
        subtitle: workerLogSubtitle(worker, logTail),
        lines: logTail.lines ?? [],
        offset: state.logOffset,
        follow: state.follow,
        size,
        empty: worker?.log_path
          ? "the daemon holds a log path for this Worker, and nothing has been written to it yet"
          : "this Worker declared no log path at spawn — the daemon never derives one (ADR 0130 rule 3)",
      });
    }

    if (state.view === "events") {
      return renderLogView({
        title: "host event lane",
        subtitle: `${socket.eventLanePath}${events.truncated ? " (tail)" : ""} — birth, death, budget-kill`,
        lines: events.records ?? [],
        offset: state.logOffset,
        follow: state.follow,
        size,
        empty: events.exists
          ? "the lane is empty: this daemon has witnessed no birth, death or budget-kill"
          : "no lane on disk yet — a daemon writes one the first time it births a Worker",
        render: (record, ctx) => renderEventRow(record, ctx),
      });
    }

    return renderDashboard({ snapshot, state, size, localProject, now: new Date().toISOString(), socket });
  }

  async function onKey(key) {
    const name = key.name;
    if (name === "ctrl-c") return "quit";

    // `help` is drawn by the overview renderer and answers the overview's keys;
    // only the two scrolling views take the reader below.
    if (state.view === "logs" || state.view === "events") {
      switch (name) {
        case "q":
        case "escape":
          state.view = "overview";
          state.logOffset = 0;
          state.follow = true;
          return;
        case "f":
          state.follow = !state.follow;
          if (state.follow) state.logOffset = 0;
          return;
        case "j":
        case "down":
          state.logOffset = Math.max(0, state.logOffset - 1);
          state.follow = state.logOffset === 0;
          return;
        case "k":
        case "up":
          state.logOffset += 1;
          state.follow = false;
          return;
        case "page-down":
          state.logOffset = Math.max(0, state.logOffset - 10);
          state.follow = state.logOffset === 0;
          return;
        case "page-up":
          state.logOffset += 10;
          state.follow = false;
          return;
        case "G":
        case "end":
          state.logOffset = 0;
          state.follow = true;
          return;
        case "g":
        case "home":
          state.logOffset = Number.MAX_SAFE_INTEGER;
          state.follow = false;
          return;
        case "r":
          await refresh();
          return;
        default:
          return;
      }
    }

    switch (name) {
      case "q":
        return "quit";
      case "escape":
        if (state.view === "overview" && state.message) {
          state.message = null;
          return;
        }
        return "quit";
      case "r":
        state.message = null;
        await refresh();
        return;
      case "j":
      case "down":
        state.selected = Math.min(workers().length - 1, state.selected + 1);
        return;
      case "k":
      case "up":
        state.selected = Math.max(0, state.selected - 1);
        return;
      case "l":
      case "enter": {
        const worker = selectedWorker();
        if (!worker) {
          state.message = "no Worker to open a log for — this host is idle";
          return;
        }
        state.logWorkerId = worker.worker_id;
        state.view = "logs";
        state.logOffset = 0;
        state.follow = true;
        await refresh();
        return;
      }
      case "e":
        state.view = "events";
        state.logOffset = 0;
        state.follow = true;
        await refresh();
        return;
      case "g":
        state.mode = state.mode === "global" ? "local" : "global";
        state.message =
          state.mode === "local" && localProject == null
            ? "this directory resolves to no project label, so local mode has nothing to scope to"
            : null;
        await refresh();
        return;
      case "v":
        state.verbose = !state.verbose;
        return;
      case "n": {
        const line = await client
          .statuslineString(state.mode === "local" ? localProject ?? undefined : undefined, { mode: state.mode, verbose: false })
          .catch(() => null);
        await notify("redskilled", {
          body: line?.line ?? snapshot.error?.message ?? "no host answered",
          position: config.notifications.position,
          sound: config.notifications.sound,
        });
        state.message = "sent as a herdr notification";
        return;
      }
      case "?":
        state.view = state.view === "help" ? "overview" : "help";
        return;
      default:
        return;
    }
  }

  await runScreen({
    title: "red-skills",
    refreshMs: flags.refreshMs ?? config.refreshMs,
    onTick: refresh,
    render,
    onKey,
  });
}
