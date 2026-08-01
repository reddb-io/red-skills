/**
 * signals — what changed between two reads, as things worth interrupting for.
 *
 * A notification is an interruption, so the bar is a **transition**, never a
 * state: "12 pull requests are open" is the dashboard's job, and "a 13th opened"
 * is this module's. Everything here therefore compares the previous read to the
 * current one and emits nothing when they agree.
 *
 * **The event lane is preferred over set arithmetic.** A Worker that disappears
 * between two reads tells you it is gone; the lane tells you whether it exited
 * 0, was killed over budget, or took a signal — and that difference is the whole
 * reason an operator wanted to be told. Set-diffing is the fallback for a host
 * whose lane this process cannot read.
 *
 * PURE: every input is passed in, including the instant.
 */

/** The keys a signal can carry, so a caller can throttle per kind and per subject. */
export const SIGNAL_KINDS = [
  "daemon-reach",
  "worker-birth",
  "worker-death",
  "worker-budget-kill",
  "budget-pressure",
  "staleness",
  "upgrade",
  "pull-requests",
];

/** The state a watcher carries between reads. PURE. */
export function snapshotState(snapshot, { events = [] } = {}) {
  if (!snapshot.reachable) {
    return { reachable: false, workers: {}, pullRequests: {}, lastEventTs: null, stale: false, upgrade: null };
  }
  const payload = snapshot.payload;
  const workers = {};
  for (const worker of payload.workers ?? []) {
    workers[worker.worker_id] = {
      project_label: worker.project_label,
      used_fraction: worker.budget?.used_fraction ?? null,
    };
  }
  const pullRequests = {};
  for (const project of payload.repository_activity?.projects ?? []) {
    if (project.outcome === "counted" && project.counts) {
      pullRequests[project.project_label] = {
        repository: project.repository,
        open: project.counts.open_pull_requests,
      };
    }
  }
  const upgrade = snapshot.hostState?.upgrade ?? null;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  return {
    reachable: true,
    daemonPid: payload.daemon?.pid ?? null,
    workers,
    pullRequests,
    stale: payload.staleness?.stale === true,
    lastEventTs: typeof lastEvent?.ts === "string" ? lastEvent.ts : null,
    upgrade: upgrade
      ? {
          running_version: upgrade.running_version,
          published_version: upgrade.published_version ?? null,
          newer_published: upgrade.newer_published ?? 0,
          major_held: upgrade.major_held ?? 0,
        }
      : null,
  };
}

function pushIf(list, enabled, signal) {
  if (enabled) list.push(signal);
}

/**
 * Every transition between `previous` and `current` worth telling an operator.
 *
 * A first read has no previous state and emits nothing but reachability: a
 * watcher that announced every live Worker on herdr's session restore would make
 * the first notification of the day a wall of things that had not changed.
 */
export function detectSignals({ previous, current, snapshot, events = [], config, now = new Date().toISOString() }) {
  const wanted = config.notifications ?? {};
  const signals = [];
  const first = previous == null;

  if (first) {
    if (!current.reachable) {
      pushIf(signals, wanted.daemonReach !== false, {
        kind: "daemon-reach",
        key: "daemon-reach:down",
        title: "redskilled is not answering",
        body: snapshot?.error?.message ?? "no host answered",
        sound: "request",
      });
    }
    return signals;
  }

  if (previous.reachable !== current.reachable) {
    pushIf(signals, wanted.daemonReach !== false, {
      kind: "daemon-reach",
      key: current.reachable ? "daemon-reach:up" : "daemon-reach:down",
      title: current.reachable ? "redskilled is back" : "redskilled is not answering",
      body: current.reachable
        ? `pid ${current.daemonPid} · ${Object.keys(current.workers).length} Worker(s) held`
        : snapshot?.error?.message ?? "no host answered",
      sound: current.reachable ? "done" : "request",
    });
  }

  if (!current.reachable) return signals;

  // A daemon that just came back is a fresh baseline, not a burst of news. Every
  // Worker it holds would otherwise read as newly born and every one it no longer
  // holds as newly dead, which is the same wall of unchanged facts a first read
  // refuses — and it would arrive at the worst moment, right after an outage.
  if (previous.reachable === false) return signals;

  // Restart, not death: the daemon re-attaches to its Workers by unit name, so a
  // new pid holding the same work is an upgrade or a crash, never an evacuation.
  if (previous.reachable && previous.daemonPid != null && current.daemonPid !== previous.daemonPid) {
    pushIf(signals, wanted.daemonReach !== false, {
      kind: "daemon-reach",
      key: `daemon-reach:pid:${current.daemonPid}`,
      title: "redskilled restarted",
      body: `pid ${previous.daemonPid} → ${current.daemonPid} · re-attached to ${Object.keys(current.workers).length} Worker(s)`,
    });
  }

  const fresh = events.filter((event) => previous.lastEventTs == null || String(event.ts) > previous.lastEventTs);
  const laneCovered = new Set();

  for (const event of fresh) {
    laneCovered.add(String(event.worker_id));
    if (event.event === "worker-budget-kill") {
      pushIf(signals, wanted.budgetPressure !== false, {
        kind: "worker-budget-kill",
        key: `worker-budget-kill:${event.worker_id}`,
        title: "Worker killed over budget",
        body: `${event.worker_id} · ${event.project_label ?? "?"} · ${event.detail ?? "the daemon terminated it over its declared ceiling"}`,
        sound: "request",
      });
      continue;
    }
    if (event.event === "worker-death") {
      const ending = event.signal
        ? `signal ${event.signal}`
        : event.exit_code == null
          ? "exit unknown"
          : `exit ${event.exit_code}`;
      pushIf(signals, wanted.workerDeath !== false, {
        kind: "worker-death",
        key: `worker-death:${event.worker_id}`,
        title: event.exit_code === 0 ? "Worker finished" : "Worker ended",
        body: `${event.worker_id} · ${event.project_label ?? "?"} · ${ending}`,
        sound: event.exit_code === 0 ? "done" : "request",
      });
      continue;
    }
    if (event.event === "worker-birth") {
      pushIf(signals, wanted.workerBirth === true, {
        kind: "worker-birth",
        key: `worker-birth:${event.worker_id}`,
        title: "Worker started",
        body: `${event.worker_id} · ${event.project_label ?? "?"}${event.unit ? ` · ${event.unit}` : " · no unit"}`,
      });
    }
  }

  for (const [id, worker] of Object.entries(current.workers)) {
    if (previous.workers[id] || laneCovered.has(id)) continue;
    pushIf(signals, wanted.workerBirth === true, {
      kind: "worker-birth",
      key: `worker-birth:${id}`,
      title: "Worker started",
      body: `${id} · ${worker.project_label}`,
    });
  }
  for (const [id, worker] of Object.entries(previous.workers)) {
    if (current.workers[id] || laneCovered.has(id)) continue;
    pushIf(signals, wanted.workerDeath !== false, {
      kind: "worker-death",
      key: `worker-death:${id}`,
      title: "Worker ended",
      // Said plainly: the set diff saw it go and the lane did not say how, and
      // presenting that as a clean exit would be inventing the fact that matters.
      body: `${id} · ${worker.project_label} · the host no longer holds it; the event lane did not say how it ended`,
    });
  }

  const threshold = wanted.budgetPressureAt ?? 0.9;
  for (const [id, worker] of Object.entries(current.workers)) {
    const before = previous.workers[id]?.used_fraction ?? null;
    const after = worker.used_fraction;
    if (after == null || after < threshold) continue;
    if (before != null && before >= threshold) continue;
    pushIf(signals, wanted.budgetPressure !== false, {
      kind: "budget-pressure",
      key: `budget-pressure:${id}`,
      title: "Worker near its memory ceiling",
      body: `${id} · ${worker.project_label} · ${Math.round(after * 100)}% of its declared budget`,
      sound: "request",
    });
  }

  if (current.stale && !previous.stale) {
    pushIf(signals, wanted.staleness !== false, {
      kind: "staleness",
      key: "staleness:on",
      title: "redskilled stopped measuring",
      body: snapshot?.payload?.staleness?.reason ?? "the sampler has not measured inside its staleness window",
    });
  }

  if (current.upgrade && previous.upgrade) {
    if (current.upgrade.newer_published && !previous.upgrade.newer_published) {
      pushIf(signals, wanted.upgrade !== false, {
        kind: "upgrade",
        key: `upgrade:${current.upgrade.published_version}`,
        title: "redskilled has a newer version",
        body: `${current.upgrade.running_version} → ${current.upgrade.published_version}`,
      });
    }
    if (current.upgrade.major_held && !previous.upgrade.major_held) {
      pushIf(signals, wanted.upgrade !== false, {
        kind: "upgrade",
        key: "upgrade:major-hold",
        title: "redskilled is holding at a major boundary",
        body: "a newer major is published and deliberately not crossed; see `redskilled host-state`",
      });
    }
  }

  for (const [label, entry] of Object.entries(current.pullRequests)) {
    const before = previous.pullRequests[label];
    if (!before || entry.open <= before.open) continue;
    pushIf(signals, wanted.pullRequests !== false, {
      kind: "pull-requests",
      key: `pull-requests:${label}:${entry.open}`,
      title: `${entry.open} open PRs on ${entry.repository}`,
      body: `${entry.open - before.open} more than the last read`,
    });
  }

  return signals;
}

/** Drop the signals already sent inside the renotify window. PURE. */
export function throttle(signals, sentAt, { renotifyMs, now }) {
  const nowMs = Date.parse(now);
  const kept = [];
  const stamped = { ...sentAt };
  for (const signal of signals) {
    const last = stamped[signal.key];
    const lastMs = last == null ? null : Date.parse(last);
    if (lastMs != null && Number.isFinite(lastMs) && nowMs - lastMs < renotifyMs) continue;
    stamped[signal.key] = now;
    kept.push(signal);
  }
  return { signals: kept, sentAt: stamped };
}
