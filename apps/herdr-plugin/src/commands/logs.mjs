/**
 * logs — the standalone log pane, for an operator who wants it beside the
 * dashboard rather than inside it.
 *
 * It answers the same two sources the dashboard's log view does and is chosen
 * the same way: a Worker id (or the newest Worker of a project) tails that
 * Worker's own file; `--events` reads the daemon's host event lane.
 */
import { createRedskilledClient, readRedskilledSnapshot } from "../redskilled/client.mjs";
import { readEventLane } from "../redskilled/event-lane.mjs";
import { tailFile } from "../redskilled/log-tail.mjs";
import { resolveRedskilledPaths } from "../redskilled/paths.mjs";
import { resolveProjectLabel } from "../redskilled/project-identity.mjs";
import { renderEventRow, renderLogView, workerLogSubtitle } from "../ui/logs.mjs";
import { runScreen } from "../ui/screen.mjs";

/**
 * Which Worker this pane is about. PURE.
 *
 * An explicit id wins; otherwise the newest Worker of the named project, and
 * otherwise the newest Worker on the host. "Newest" rather than "first" because
 * an operator opening a log during a drain is asking about what just started.
 */
export function chooseWorker(workers, { workerId, project }) {
  if (workerId) return workers.find((worker) => worker.worker_id === workerId) ?? null;
  const pool = project ? workers.filter((worker) => worker.project_label === project) : workers;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
}

export async function runLogs({ config, flags = {} }) {
  const socket = resolveRedskilledPaths({ socketPath: flags.socket ?? config.socketPath });
  const client = createRedskilledClient({ socketPath: socket.socketPath, timeoutMs: config.timeoutMs });

  const wantEvents = flags.events === true;
  const workerId = flags.worker ?? process.env.RED_SKILLS_WORKER ?? null;
  const project = flags.project ?? (flags.local ? await resolveProjectLabel(process.cwd()).catch(() => null) : null);

  const state = { offset: 0, follow: true };
  let subtitle = wantEvents ? socket.eventLanePath : "resolving…";
  let lines = [];
  let worker = null;
  let events = { records: [], exists: false, truncated: false };
  let tail = { lines: [], exists: false };

  async function refresh() {
    if (wantEvents) {
      events = await readEventLane(socket.eventLanePath).catch(() => ({ records: [], exists: false }));
      lines = events.records;
      subtitle = `${socket.eventLanePath}${events.truncated ? " (tail)" : ""} — birth, death, budget-kill`;
      return;
    }

    const snapshot = await readRedskilledSnapshot(client);
    if (!snapshot.reachable) {
      lines = [];
      worker = null;
      subtitle = snapshot.error?.message ?? "no host answered";
      return;
    }
    worker = chooseWorker(snapshot.payload.workers ?? [], { workerId, project });
    tail = await tailFile(worker?.log_path).catch((error) => ({ lines: [], exists: false, reason: error.message }));
    lines = tail.lines ?? [];
    subtitle = workerLogSubtitle(worker, tail);
  }

  function render(size) {
    return renderLogView({
      title: wantEvents ? "host event lane" : "worker log",
      subtitle,
      lines,
      offset: state.offset,
      follow: state.follow,
      size,
      empty: wantEvents
        ? "no lane on disk yet — a daemon writes one the first time it births a Worker"
        : worker == null
          ? "no Worker matched: an idle host, or a project with nothing running"
          : "nothing has been written to this Worker's log yet",
      ...(wantEvents ? { render: (record, ctx) => renderEventRow(record, ctx) } : {}),
    });
  }

  async function onKey(key) {
    switch (key.name) {
      case "q":
      case "escape":
      case "ctrl-c":
        return "quit";
      case "f":
        state.follow = !state.follow;
        if (state.follow) state.offset = 0;
        return;
      case "j":
      case "down":
        state.offset = Math.max(0, state.offset - 1);
        state.follow = state.offset === 0;
        return;
      case "k":
      case "up":
        state.offset += 1;
        state.follow = false;
        return;
      case "page-down":
        state.offset = Math.max(0, state.offset - 10);
        state.follow = state.offset === 0;
        return;
      case "page-up":
        state.offset += 10;
        state.follow = false;
        return;
      case "G":
      case "end":
        state.offset = 0;
        state.follow = true;
        return;
      case "g":
      case "home":
        state.offset = Number.MAX_SAFE_INTEGER;
        state.follow = false;
        return;
      case "r":
        await refresh();
        return;
      default:
        return;
    }
  }

  await runScreen({
    title: wantEvents ? "red-skills events" : "red-skills logs",
    refreshMs: flags.refreshMs ?? Math.max(1_000, config.refreshMs),
    onTick: refresh,
    render,
    onKey,
  });
}
