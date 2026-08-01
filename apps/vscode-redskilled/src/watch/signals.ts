/**
 * signals — what changed between two reads, as things worth interrupting for.
 *
 * A notification is an interruption, so the bar is a **transition**, never a
 * state: "12 pull requests are open" is the tree's job, and "a 13th opened" is
 * this module's. Everything here compares the previous read to the current one
 * and emits nothing when they agree.
 *
 * **The event lane is preferred over set arithmetic.** A Worker that disappears
 * between two reads tells you it is gone; the lane tells you whether it exited 0,
 * was killed over budget, or took a signal — and that difference is the whole
 * reason an operator wanted to be told. Set-diffing is the fallback for a host
 * whose lane this process cannot read.
 *
 * PURE: every input is passed in, including the instant.
 */
import type { HostSnapshot } from "../model/snapshot.js";
import type { RedskilledHostEvent } from "../redskilled/event-lane.js";
import { formatPercent } from "../model/format.js";

export type SignalKind =
  | "daemon-reach"
  | "worker-birth"
  | "worker-death"
  | "worker-budget-kill"
  | "budget-pressure"
  | "staleness"
  | "upgrade"
  | "pull-requests";

/** How loudly one signal should land in the editor. */
export type SignalSeverity = "info" | "warning";

export interface Signal {
  readonly kind: SignalKind;
  /** The throttle key: one subject of one kind, so a burst collapses correctly. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly severity: SignalSeverity;
}

/** Which transitions the operator asked to hear about. */
export interface NotificationPreferences {
  readonly daemonReach: boolean;
  readonly workerBirth: boolean;
  readonly workerDeath: boolean;
  readonly budgetPressure: boolean;
  readonly budgetPressureAt: number;
  readonly staleness: boolean;
  readonly upgrade: boolean;
  readonly pullRequests: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  daemonReach: true,
  // Off by default: a busy host would make this the loudest thing in the editor.
  workerBirth: false,
  workerDeath: true,
  budgetPressure: true,
  budgetPressureAt: 0.9,
  staleness: true,
  upgrade: true,
  pullRequests: true,
};

interface WatchedWorker {
  readonly projectLabel: string;
  readonly usedFraction: number | null;
}

interface WatchedUpgrade {
  readonly runningVersion: string;
  readonly publishedVersion: string | null;
  readonly newerPublished: number;
  readonly majorHeld: number;
}

interface WatchedRepository {
  readonly repository: string;
  readonly open: number;
}

/** Everything a watcher must remember between two reads. PURE. */
export interface WatchState {
  readonly reachable: boolean;
  readonly daemonPid: number | null;
  readonly workers: Readonly<Record<string, WatchedWorker>>;
  readonly pullRequests: Readonly<Record<string, WatchedRepository>>;
  readonly stale: boolean;
  readonly lastEventTs: string | null;
  readonly upgrade: WatchedUpgrade | null;
}

const UNREACHABLE: WatchState = {
  reachable: false,
  daemonPid: null,
  workers: {},
  pullRequests: {},
  stale: false,
  lastEventTs: null,
  upgrade: null,
};

/** Reduce one snapshot to the state the next comparison needs. PURE. */
export function watchStateOf(snapshot: HostSnapshot): WatchState {
  const lastEvent = snapshot.lane.events.at(-1) ?? null;
  const lastEventTs = typeof lastEvent?.ts === "string" ? lastEvent.ts : null;
  if (!snapshot.reachable || !snapshot.payload) return { ...UNREACHABLE, lastEventTs };

  const payload = snapshot.payload;
  const workers: Record<string, WatchedWorker> = {};
  for (const worker of payload.workers) {
    workers[worker.worker_id] = {
      projectLabel: worker.project_label,
      usedFraction: worker.budget.used_fraction,
    };
  }

  const pullRequests: Record<string, WatchedRepository> = {};
  for (const project of payload.repository_activity.projects) {
    if (project.outcome === "counted" && project.counts) {
      pullRequests[project.project_label] = {
        repository: project.repository,
        open: project.counts.open_pull_requests,
      };
    }
  }

  const upgrade = snapshot.hostState?.upgrade ?? null;
  return {
    reachable: true,
    daemonPid: payload.daemon.pid,
    workers,
    pullRequests,
    stale: payload.staleness.stale,
    lastEventTs,
    upgrade: upgrade
      ? {
        runningVersion: upgrade.running_version,
        publishedVersion: upgrade.published_version,
        newerPublished: upgrade.newer_published,
        majorHeld: upgrade.major_held,
      }
      : null,
  };
}

export interface DetectSignalsInput {
  /** `null` on the first read of the session. */
  readonly previous: WatchState | null;
  readonly current: WatchState;
  readonly snapshot: HostSnapshot;
  readonly preferences: NotificationPreferences;
}

/**
 * Every transition between `previous` and `current` worth telling an operator.
 *
 * A first read has no previous state and emits nothing but an unreachable host: a
 * watcher that announced every live Worker when the window opened would make the
 * first notification of the day a wall of things that had not changed.
 */
export function detectSignals(input: DetectSignalsInput): Signal[] {
  const { previous, current, snapshot, preferences } = input;
  const signals: Signal[] = [];
  const push = (enabled: boolean, signal: Signal): void => {
    if (enabled) signals.push(signal);
  };

  if (previous === null) {
    if (!current.reachable) push(preferences.daemonReach, daemonDown(snapshot));
    return signals;
  }

  if (previous.reachable !== current.reachable) {
    push(
      preferences.daemonReach,
      current.reachable
        ? {
          kind: "daemon-reach",
          key: "daemon-reach:up",
          title: "redskilled is back",
          body: `pid ${current.daemonPid} · ${Object.keys(current.workers).length} Worker(s) held`,
          severity: "info",
        }
        : daemonDown(snapshot),
    );
  }

  if (!current.reachable) return signals;

  // A daemon that just came back is a fresh baseline, not a burst of news. Every
  // Worker it holds would otherwise read as newly born and every one it no longer
  // holds as newly dead — a wall of unchanged facts, arriving at the worst moment.
  if (!previous.reachable) return signals;

  // Restart, not evacuation: the daemon re-attaches to its Workers by unit name,
  // so a new pid holding the same work is an upgrade or a crash, never a drain.
  if (previous.daemonPid !== null && current.daemonPid !== previous.daemonPid) {
    push(preferences.daemonReach, {
      kind: "daemon-reach",
      key: `daemon-reach:pid:${current.daemonPid}`,
      title: "redskilled restarted",
      body: `pid ${previous.daemonPid} → ${current.daemonPid} · re-attached to ${Object.keys(current.workers).length} Worker(s)`,
      severity: "warning",
    });
  }

  const fresh = snapshot.lane.events.filter(
    (event) => previous.lastEventTs === null || String(event.ts) > previous.lastEventTs,
  );
  const laneCovered = new Set<string>();
  for (const event of fresh) {
    laneCovered.add(String(event.worker_id));
    const signal = signalForEvent(event);
    if (signal === null) continue;
    push(enabledFor(signal.kind, preferences), signal);
  }

  for (const [id, worker] of Object.entries(current.workers)) {
    if (previous.workers[id] || laneCovered.has(id)) continue;
    push(preferences.workerBirth, {
      kind: "worker-birth",
      key: `worker-birth:${id}`,
      title: "Worker started",
      body: `${id} · ${worker.projectLabel}`,
      severity: "info",
    });
  }
  for (const [id, worker] of Object.entries(previous.workers)) {
    if (current.workers[id] || laneCovered.has(id)) continue;
    push(preferences.workerDeath, {
      kind: "worker-death",
      key: `worker-death:${id}`,
      title: "Worker ended",
      // Said plainly: the set diff saw it go and the lane did not say how, and
      // presenting that as a clean exit would invent the fact that matters.
      body: `${id} · ${worker.projectLabel} · the host no longer holds it; the event lane did not say how it ended`,
      severity: "warning",
    });
  }

  for (const [id, worker] of Object.entries(current.workers)) {
    const before = previous.workers[id]?.usedFraction ?? null;
    const after = worker.usedFraction;
    if (after === null || after < preferences.budgetPressureAt) continue;
    if (before !== null && before >= preferences.budgetPressureAt) continue;
    push(preferences.budgetPressure, {
      kind: "budget-pressure",
      key: `budget-pressure:${id}`,
      title: "Worker near its memory ceiling",
      body: `${id} · ${worker.projectLabel} · ${formatPercent(after)} of its declared budget`,
      severity: "warning",
    });
  }

  if (current.stale && !previous.stale) {
    push(preferences.staleness, {
      kind: "staleness",
      key: "staleness:on",
      title: "redskilled stopped measuring",
      body: snapshot.payload?.staleness.reason ?? "the sampler has not measured inside its staleness window",
      severity: "warning",
    });
  }

  if (current.upgrade && previous.upgrade) {
    if (current.upgrade.newerPublished && !previous.upgrade.newerPublished) {
      push(preferences.upgrade, {
        kind: "upgrade",
        key: `upgrade:${current.upgrade.publishedVersion}`,
        title: "redskilled has a newer version",
        body: `${current.upgrade.runningVersion} → ${current.upgrade.publishedVersion}`,
        severity: "info",
      });
    }
    if (current.upgrade.majorHeld && !previous.upgrade.majorHeld) {
      push(preferences.upgrade, {
        kind: "upgrade",
        key: "upgrade:major-hold",
        title: "redskilled is holding at a major boundary",
        body: "a newer major is published and deliberately not crossed; see `redskilled host-state`",
        severity: "warning",
      });
    }
  }

  for (const [label, entry] of Object.entries(current.pullRequests)) {
    const before = previous.pullRequests[label];
    if (!before || entry.open <= before.open) continue;
    push(preferences.pullRequests, {
      kind: "pull-requests",
      key: `pull-requests:${label}:${entry.open}`,
      title: `${entry.open} open PRs on ${entry.repository}`,
      body: `${entry.open - before.open} more than the last read`,
      severity: "info",
    });
  }

  return signals;
}

function daemonDown(snapshot: HostSnapshot): Signal {
  return {
    kind: "daemon-reach",
    key: "daemon-reach:down",
    title: "redskilled is not answering",
    body: snapshot.error?.message ?? "no host answered",
    severity: "warning",
  };
}

function signalForEvent(event: RedskilledHostEvent): Signal | null {
  if (event.event === "worker-budget-kill") {
    return {
      kind: "worker-budget-kill",
      key: `worker-budget-kill:${event.worker_id}`,
      title: "Worker killed over budget",
      body: `${event.worker_id} · ${event.project_label || "?"} · ${event.detail ?? "the daemon terminated it over its declared ceiling"}`,
      severity: "warning",
    };
  }
  if (event.event === "worker-death") {
    const ending = event.signal
      ? `signal ${event.signal}`
      : event.exit_code === null
        ? "exit unknown"
        : `exit ${event.exit_code}`;
    return {
      kind: "worker-death",
      key: `worker-death:${event.worker_id}`,
      title: event.exit_code === 0 ? "Worker finished" : "Worker ended",
      body: `${event.worker_id} · ${event.project_label || "?"} · ${ending}`,
      severity: event.exit_code === 0 ? "info" : "warning",
    };
  }
  if (event.event === "worker-birth") {
    return {
      kind: "worker-birth",
      key: `worker-birth:${event.worker_id}`,
      title: "Worker started",
      body: `${event.worker_id} · ${event.project_label || "?"}${event.unit ? ` · ${event.unit}` : " · no unit"}`,
      severity: "info",
    };
  }
  return null;
}

function enabledFor(kind: SignalKind, preferences: NotificationPreferences): boolean {
  switch (kind) {
    case "worker-birth":
      return preferences.workerBirth;
    case "worker-death":
      return preferences.workerDeath;
    case "worker-budget-kill":
      return preferences.budgetPressure;
    default:
      return true;
  }
}

/** Drop the signals already shown inside the renotify window. PURE. */
export function throttle(
  signals: readonly Signal[],
  sentAt: Readonly<Record<string, string>>,
  options: { renotifyMs: number; now: string },
): { signals: Signal[]; sentAt: Record<string, string> } {
  const nowMs = Date.parse(options.now);
  const stamped: Record<string, string> = { ...sentAt };
  const kept: Signal[] = [];
  for (const signal of signals) {
    const last = stamped[signal.key];
    const lastMs = last === undefined ? null : Date.parse(last);
    if (lastMs !== null && Number.isFinite(lastMs) && nowMs - lastMs < options.renotifyMs) continue;
    stamped[signal.key] = options.now;
    kept.push(signal);
  }
  return { signals: kept, sentAt: stamped };
}
