/**
 * nodes — what the three trees show, as plain values.
 *
 * The whole rendering decision lives here and nothing in this file imports
 * `vscode`: a `TreeDataProvider` then has one job, turning a node into a
 * `TreeItem`, and every layout question — what a row says, what nests under it,
 * what an unreachable host looks like — is answered by a pure function a test can
 * call. PURE.
 */
import type { RedskilledStatuslineWorker } from "@reddb-io/redskilled/statusline-payload";
import type { RedskilledHostEvent } from "../redskilled/event-lane.js";
import type { HostSnapshot } from "./snapshot.js";
import { formatBytes, formatClock, formatDuration, formatPercent } from "./format.js";

/** What a row means, so the provider picks an icon and a context value from ONE word. */
export type NodeKind =
  | "absence"
  | "host"
  | "worker"
  | "detail"
  | "event"
  | "repository";

/** How a row reads at a glance: ordinary, worth noticing, or wrong. */
export type NodeTone = "normal" | "warning" | "error";

export interface ViewNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  /** The dimmer half of the row; empty when the label says everything. */
  readonly description: string;
  readonly tooltip: string;
  readonly tone: NodeTone;
  readonly children: readonly ViewNode[];
  /** The Worker this row belongs to, for the commands that act on one. */
  readonly workerId?: string;
  readonly workspacePath?: string;
  readonly logPath?: string | null;
}

function node(partial: Omit<ViewNode, "description" | "tone" | "children"> & Partial<ViewNode>): ViewNode {
  return {
    description: "",
    tone: "normal",
    children: [],
    ...partial,
  };
}

/** The one row every view shows instead of a list when nothing answered. PURE. */
export function unreachableNode(snapshot: HostSnapshot, idPrefix: string): ViewNode {
  return node({
    id: `${idPrefix}:unreachable`,
    kind: "absence",
    label: "redskilled is not answering",
    description: snapshot.error?.message ?? "no host answered",
    tone: "error",
    tooltip: [
      snapshot.error?.message ?? "no host answered",
      `socket: ${snapshot.socketPath}`,
      `source: ${snapshot.source}`,
      "This view never starts the daemon; `redskilled provision` and the dev bundle own that.",
    ].join("\n"),
  });
}

/**
 * The Workers tree: one host summary, then one row per Worker with its vitals.
 *
 * The host row is first and always present, including on an idle host. A panel
 * that showed nothing at all for "the daemon is up and holding no Workers" reads
 * identically to one that could not reach it, and those are opposite facts.
 */
export function buildWorkersTree(snapshot: HostSnapshot): readonly ViewNode[] {
  if (!snapshot.reachable || !snapshot.payload) return [unreachableNode(snapshot, "workers")];

  const payload = snapshot.payload;
  const host = payload.host;
  const stale = payload.staleness.stale;

  const hostRow = node({
    id: "workers:host",
    kind: "host",
    label: `${host.worker_count} Worker${host.worker_count === 1 ? "" : "s"} · ${host.project_count} project${host.project_count === 1 ? "" : "s"}`,
    description: [
      formatBytes(host.observed_rss_bytes),
      host.ceiling_used_fraction == null ? null : `${formatPercent(host.ceiling_used_fraction)} of ceiling`,
      stale ? "stale" : null,
    ].filter((part): part is string => part !== null).join(" · "),
    tone: stale ? "warning" : "normal",
    tooltip: [
      `daemon pid ${payload.daemon.pid} · v${payload.daemon.daemon_version} · protocol ${payload.daemon.protocol_version}`,
      `measured ${payload.staleness.measured_worker_count} of ${host.worker_count} Worker(s)`,
      payload.staleness.reason,
      `read at ${formatClock(snapshot.readAt)}`,
    ].join("\n"),
  });

  const workerRows = [...payload.workers]
    .sort((a, b) => a.project_label.localeCompare(b.project_label) || a.worker_id.localeCompare(b.worker_id))
    .map(buildWorkerNode);

  if (workerRows.length === 0) {
    return [
      hostRow,
      node({
        id: "workers:idle",
        kind: "absence",
        label: "no Worker is running",
        description: "the host is up and holding none",
        tooltip: "The daemon answered. It is holding no Worker on this machine right now.",
      }),
    ];
  }

  return [hostRow, ...workerRows];
}

/** One Worker row, with its vitals nested underneath. PURE. */
export function buildWorkerNode(worker: RedskilledStatuslineWorker): ViewNode {
  const pressure = worker.budget.used_fraction;
  const tone: NodeTone = pressure != null && pressure >= 0.9
    ? "error"
    : !worker.isolated || !worker.vitals.fresh
      ? "warning"
      : "normal";

  const children: ViewNode[] = [
    detail(worker, "memory", `${formatBytes(worker.vitals.rss_bytes)} of ${worker.budget.declared ?? "no declared ceiling"}`, formatPercent(pressure)),
    detail(worker, "uptime", formatDuration(worker.uptime_ms), `pid ${worker.pid} · ${worker.state}`),
    detail(worker, "isolation", worker.isolated ? (worker.unit ?? "isolated") : "no unit of its own", worker.isolated ? "" : "its charge lands on the daemon"),
    detail(worker, "workspace", worker.workspace_path, ""),
  ];

  if (worker.log.last_line) {
    children.push(detail(worker, "last-line", worker.log.last_line, worker.log.source ?? ""));
  }
  for (const [index, warning] of worker.warnings.entries()) {
    children.push({
      ...detail(worker, `warning-${index}`, warning, ""),
      tone: "warning",
    });
  }

  return node({
    id: `workers:${worker.worker_id}`,
    kind: "worker",
    label: worker.worker_id,
    description: `${worker.project_label} · ${formatBytes(worker.vitals.rss_bytes)}${pressure == null ? "" : ` (${formatPercent(pressure)})`}`,
    tone,
    tooltip: [
      `${worker.worker_id} · ${worker.project_label}`,
      `pid ${worker.pid} · started ${formatClock(worker.started_at)} · up ${formatDuration(worker.uptime_ms)}`,
      `${formatBytes(worker.vitals.rss_bytes)} of ${worker.budget.declared ?? "no declared ceiling"}${worker.vitals.fresh ? "" : " (not measured recently)"}`,
      worker.workspace_path,
    ].join("\n"),
    children,
    workerId: worker.worker_id,
    workspacePath: worker.workspace_path,
    logPath: workerLogPath(worker),
  });
}

/**
 * Where this Worker's log is, when the payload carries one.
 *
 * `log_path` is not part of the statusline Worker shape on every daemon version,
 * so it is read defensively rather than declared: a client that typed it as
 * present would crash the whole tree against a daemon that omits it.
 */
export function workerLogPath(worker: RedskilledStatuslineWorker): string | null {
  const candidate = (worker as { log_path?: unknown }).log_path;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : null;
}

function detail(
  worker: RedskilledStatuslineWorker,
  key: string,
  label: string,
  description: string,
): ViewNode {
  return node({
    id: `workers:${worker.worker_id}:${key}`,
    kind: "detail",
    label,
    description,
    tooltip: description ? `${label}\n${description}` : label,
    workerId: worker.worker_id,
  });
}

/**
 * The host event lane, newest first.
 *
 * Newest first, unlike the lane's own order: a panel is read from the top, and
 * an operator opening it after an incident wants the last thing that happened,
 * not the first thing the daemon ever did.
 */
export function buildEventsTree(snapshot: HostSnapshot): readonly ViewNode[] {
  const { lane } = snapshot;
  if (!lane.exists) {
    return [
      node({
        id: "events:absent",
        kind: "absence",
        label: "no event lane on this host",
        description: lane.path,
        tooltip: `The daemon appends its lane to ${lane.path}. Nothing is there yet.`,
      }),
    ];
  }
  if (lane.events.length === 0) {
    return [
      node({
        id: "events:empty",
        kind: "absence",
        label: "the event lane is empty",
        description: lane.truncated ? "only the tail was read" : "",
        tooltip: lane.path,
      }),
    ];
  }

  const rows = [...lane.events].reverse().map((event, index) => buildEventNode(event, index));
  if (!lane.truncated) return rows;
  return [
    ...rows,
    node({
      id: "events:truncated",
      kind: "absence",
      label: "…older events were not read",
      description: "the lane is longer than this view's window",
      tooltip: `${lane.path}\nOnly the head's segment header and the tail window were decoded.`,
    }),
  ];
}

/** One lane row: what happened, to whom, and how it ended. PURE. */
export function buildEventNode(event: RedskilledHostEvent, index: number): ViewNode {
  const ending = event.signal
    ? `signal ${event.signal}`
    : event.exit_code == null
      ? null
      : `exit ${event.exit_code}`;

  const tone: NodeTone = event.event === "worker-budget-kill"
    ? "error"
    : event.event === "worker-death" && event.exit_code !== 0
      ? "warning"
      : event.event === "daemon-stop"
        ? "warning"
        : "normal";

  return node({
    id: `events:${index}:${event.ts}:${event.worker_id}`,
    kind: "event",
    label: `${formatClock(event.ts)} ${event.event}`,
    description: [event.worker_id, event.project_label || null, ending].filter(Boolean).join(" · "),
    tone,
    tooltip: [
      `${event.ts} · ${event.event}`,
      `${event.worker_id}${event.project_label ? ` · ${event.project_label}` : ""} · pid ${event.pid}`,
      ending ?? "the daemon did not witness the exit",
      event.reason ? `reason: ${event.reason}` : null,
      event.detail ?? null,
    ].filter((line): line is string => line !== null).join("\n"),
    workerId: event.worker_id,
    workspacePath: event.workspace_path,
    logPath: event.log_path,
  });
}

/**
 * The open pull requests of every registered project, as the host polled them.
 *
 * Counts, never a list of PRs: they ride on the payload because the tracker quota
 * is shared by the whole host (ADR 0130 Amendment 1), and a view that fetched its
 * own would spend the same token again on every refresh.
 */
export function buildPullRequestsTree(snapshot: HostSnapshot): readonly ViewNode[] {
  if (!snapshot.reachable || !snapshot.payload) return [unreachableNode(snapshot, "pull-requests")];

  const activity = snapshot.payload.repository_activity;
  if (activity.projects.length === 0) {
    return [
      node({
        id: "pull-requests:none",
        kind: "absence",
        label: "no project reported repository activity",
        description: activity.fetched_at ? `last polled ${formatClock(activity.fetched_at)}` : "never polled",
        tooltip: "The host polls only the projects it holds a registration for.",
      }),
    ];
  }

  return activity.projects.map((project) => {
    const counted = project.outcome === "counted" && project.counts !== null;
    return node({
      id: `pull-requests:${project.project_label}`,
      kind: "repository",
      label: project.repository || project.project_label,
      description: counted
        ? `${project.counts!.open_pull_requests} PR · ${project.counts!.open_issues} issues${activity.stale ? " · stale" : ""}`
        : project.outcome,
      tone: counted ? (activity.stale ? "warning" : "normal") : "warning",
      tooltip: [
        project.project_label,
        counted
          ? `${project.counts!.open_pull_requests} open pull requests · ${project.counts!.open_issues} open issues · ${project.counts!.recently_closed} recently closed`
          : `outcome: ${project.outcome}`,
        project.detail,
        project.fetched_at ? `fetched ${formatClock(project.fetched_at)}` : "never fetched",
      ].filter(Boolean).join("\n"),
    });
  });
}
