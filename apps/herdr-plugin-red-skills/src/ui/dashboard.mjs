/**
 * dashboard — "what is this machine doing", drawn from the one document that
 * answers it.
 *
 * Every fact on this screen originates from `redskilled`. The plugin keeps no
 * private source — no pid file, no `/proc` read, no per-repository profile —
 * because the daemon is the only process holding the Worker set across projects
 * (ADR 0130), and a second authority is how two surfaces come to report different
 * states of the same instant.
 *
 * **Staleness is rendered, never re-derived.** The payload dates itself; this
 * view prints the age it was handed. A dashboard that timed the answer itself
 * would need the sample interval, the daemon's clock and its own read latency,
 * and would be subtly wrong in a way the statusline beside it is not.
 *
 * PURE: every input is passed in, so a frame can be asserted without a daemon.
 */
import { displayWidth, padEnd, padStart, style, truncate } from "./ansi.mjs";
import { ago, bytes, count, duration, meter, oneLine, percent, rate } from "./format.mjs";

const SELECTED = "▸";

function rule(label, columns) {
  const text = label ? ` ${label} ` : "";
  const width = Math.max(0, columns - displayWidth(text) - 1);
  return style.gray(`─${text}${"─".repeat(width)}`);
}

function blank() {
  return "";
}

/** The header: which daemon answered, and how current its answer is. PURE. */
export function renderHeader(snapshot, { columns, now }) {
  if (!snapshot.reachable) {
    return [
      ` ${style.bold(style.brightRed("redskilled"))} ${style.gray("·")} ${style.brightRed("no host answered")}`,
      ` ${style.gray(truncate(snapshot.error?.message ?? "the daemon did not answer", columns - 2))}`,
    ];
  }

  const daemon = snapshot.payload.daemon;
  const staleness = snapshot.payload.staleness;
  const badge = staleness.stale
    ? style.brightYellow("● stale")
    : style.brightGreen("● live");
  // The payload's engine block first, the host-state's upgrade only where the
  // block is absent: one read answers "is my engine current" now, and the second
  // read stays only so a daemon older than the block still renders (ADR 0130
  // rule 3).
  const engine = snapshot.payload.engine ?? null;
  const upgrade = snapshot.hostState?.upgrade;

  const left =
    ` ${style.bold(style.brightRed("redskilled"))} ${style.white(engine?.running_version ?? daemon.daemon_version)}` +
    ` ${style.gray("·")} pid ${daemon.pid}` +
    ` ${style.gray("·")} up ${duration(Date.parse(now) - Date.parse(daemon.started_at))}` +
    ` ${style.gray("·")} proto ${daemon.protocol_version}`;
  const head = `${padEnd(truncate(left, columns - 10), columns - 9)}${padStart(badge, 8)}`;

  const lines = [head];

  const scope = snapshot.hostState?.scope;
  const detail =
    ` ${style.gray("host")} ${daemon.machine_id_hash}` +
    ` ${style.gray("· session")} ${daemon.session_key_hash}` +
    (scope?.kind ? ` ${style.gray("· scope")} ${scope.kind}` : "") +
    ` ${style.gray("·")} ${staleness.stale ? style.yellow(staleness.reason) : style.gray(`measured ${duration(staleness.age_ms)} ago`)}`;
  lines.push(truncate(detail, columns));

  // A held major is the daemon saying out loud that it is deliberately behind.
  // Reporting it beside the version is the whole point: a silent hold is
  // indistinguishable from being current.
  if (upgrade?.major_held) {
    lines.push(
      truncate(
        ` ${style.brightYellow("⇡ held at major")} ${upgrade.major_hold?.held_major ?? "?"}` +
          ` ${style.gray("·")} ${upgrade.major_hold?.action ?? "see redskilled"}`,
        columns,
      ),
    );
  } else if (upgrade?.newer_published || engine?.newer_published) {
    const running = upgrade?.running_version ?? engine?.running_version ?? daemon.daemon_version;
    const published = upgrade?.published_version ?? engine?.published_version ?? "?";
    lines.push(
      truncate(
        ` ${style.brightYellow("⇡ upgrade pending")} ${running} → ${published}` +
          (upgrade?.replacement ? ` ${style.gray(`(${upgrade.replacement})`)}` : ""),
        columns,
      ),
    );
  }

  lines.push(...renderDeaths(snapshot.payload.deaths, { columns }));

  return lines;
}

/**
 * What this host could not explain, in the header where it is seen. PURE.
 *
 * In the HEADER rather than a section of its own, because a death is the answer
 * to "why is this machine not doing what I left it doing" — the first question an
 * operator opens this pane with, and one a table of live Workers cannot answer.
 * Each line names who ended it, how sure the reaper is and the fact the verdict
 * rests on; the lane holds the rest.
 *
 * An absent block and an empty one both draw nothing. A reaping that found
 * nothing has nothing to report, and a daemon too old to reap must not be
 * rendered as a machine where nothing died.
 */
export function renderDeaths(deaths, { columns }) {
  if (deaths == null || !(deaths.count > 0)) return [];
  const lines = [];
  for (const death of deaths.recent ?? []) {
    lines.push(
      truncate(
        ` ${style.brightRed("†")} ${style.white(`${death.kind} ${death.id}`)}` +
          ` ${style.gray("·")} ${style.brightYellow(death.sender_class)}/${death.confidence}` +
          ` ${style.gray("· phase")} ${death.last_phase}` +
          (death.signal ? ` ${style.gray("· signal")} ${death.signal}` : "") +
          (death.evidence ? ` ${style.gray("·")} ${style.gray(death.evidence)}` : ""),
        columns,
      ),
    );
  }
  const hidden = deaths.count - lines.length;
  if (hidden > 0) {
    lines.push(truncate(` ${style.gray(`† ${hidden} more posed death(s) — the lane holds them all`)}`, columns));
  }
  return lines;
}

/** The host aggregate — the numbers an operator feels before an incident. PURE. */
export function renderHost(payload, { columns }) {
  const host = payload.host;
  const ceiling = host.ceiling ?? {};
  const accounting = host.budget_accounting ?? {};

  const workers = `${style.bold(String(host.worker_count))} worker${host.worker_count === 1 ? "" : "s"}`;
  const projects = `${style.bold(String(host.project_count))} project${host.project_count === 1 ? "" : "s"}`;
  const declared = host.consumption?.memory_bytes ?? null;
  const ceilingBytes = ceiling.memory_bytes ?? null;

  const memory =
    ceilingBytes == null
      ? `${style.gray("mem")} ${bytes(declared)} declared ${style.gray("· no ceiling")}`
      : `${style.gray("mem")} ${bytes(declared)}/${bytes(ceilingBytes)} ${meter(host.ceiling_used_fraction, 14)} ${padStart(percent(host.ceiling_used_fraction), 4)}`;

  const slots =
    ceiling.worker_count == null
      ? style.gray("slots ∞")
      : `${style.gray("slots")} ${host.worker_count}/${ceiling.worker_count}`;

  const lines = [
    truncate(` ${style.bold("HOST")}   ${workers} ${style.gray("·")} ${projects} ${style.gray("·")} ${slots}   ${memory}`, columns),
    truncate(
      `        ${style.gray("observed")} ${bytes(host.observed_rss_bytes)}` +
        ` ${style.gray("· measured")} ${host.measured_worker_count}/${host.worker_count}` +
        ` ${style.gray("· MemoryMax")} ${bytes(accounting.memory_max_bytes)}` +
        ` ${style.gray("· MemoryHigh")} ${bytes(accounting.memory_high_bytes)}` +
        ` ${style.gray("· cpu weight")} ${count(accounting.cpu_weight_total)}`,
      columns,
    ),
  ];

  const unisolated = accounting.unisolated_workers ?? [];
  const unaccounted = accounting.unaccounted_workers ?? [];
  if (unisolated.length > 0 || unaccounted.length > 0) {
    const parts = [];
    if (unisolated.length > 0) parts.push(`${unisolated.length} unisolated`);
    if (unaccounted.length > 0) parts.push(`${unaccounted.length} unaccounted`);
    lines.push(truncate(`        ${style.yellow(`⚠ ${parts.join(" · ")}`)} ${style.gray("— charged to the daemon, not to a unit")}`, columns));
  }

  return lines;
}

/** The window labels, in the order the section draws them. */
const METRIC_WINDOWS = [
  ["hour", "1h"],
  ["day", "24h"],
];

/**
 * How fast this machine is going, in the daemon's own arithmetic. PURE.
 *
 * **Nothing here is divided by this pane.** The rates and the shares arrive
 * derived from the one process holding the Worker set across projects; a pane
 * that kept its own counters would be a second authority on a question with one
 * answer, and the editor panel beside it would eventually print a different
 * number for the same instant (ADR 0130 rule 10).
 *
 * **An absence draws a dash and says why, never a zero.** `0 tokens/min` is a
 * machine that spent nothing; a window nothing published into is a machine
 * nobody measured, and an operator reading the first for the second stops
 * looking exactly when they should start.
 */
export function renderMetrics(payload, { columns }) {
  const metrics = payload.metrics ?? null;
  const lines = [rule("METRICS", columns)];

  if (metrics == null) {
    lines.push(
      truncate(` ${style.gray("this daemon derives no metrics — the block is absent, and an absent block is not an idle machine")}`, columns),
    );
    return lines;
  }

  lines.push(
    style.gray(
      truncate(
        `   ${padEnd("window", 6)} ${padStart("tokens/min", 11)} ${padStart("tools/min", 10)} ${padStart("issues/hr", 10)}  unavailable`,
        columns,
      ),
    ),
  );

  for (const [key, label] of METRIC_WINDOWS) {
    const window = metrics[key];
    if (window == null) continue;
    const unavailable = (window.unavailable ?? []).length > 0
      ? style.yellow((window.unavailable ?? []).join(" · "))
      : style.gray("—");
    lines.push(
      truncate(
        `   ${padEnd(label, 6)} ${padStart(rateCell(window.tokens_per_min), 11)}` +
          ` ${padStart(rateCell(window.tools_per_min), 10)} ${padStart(rateCell(window.issues_per_hour), 10)}  ${unavailable}`,
        columns,
      ),
    );
    lines.push(...shareLines(window, label, { columns }));
  }

  return lines;
}

/** One rate, or the dash that stands for "nobody measured it". PURE. */
function rateCell(metric) {
  if (metric == null || metric.value == null) return style.gray("—");
  return style.bold(rate(metric.value));
}

/** How one window's Workers divide, by runner and by model. PURE. */
function shareLines(window, label, { columns }) {
  const lines = [];
  for (const shares of [window.runner_share, window.model_share]) {
    if (shares == null) continue;
    const name = padEnd(shares.dimension, 6);
    const list = shares.shares ?? [];
    if (list.length === 0) {
      // The reason and not merely an empty row: "no Worker ran" and "the Workers
      // that ran published no model" send an operator to different places.
      lines.push(
        truncate(
          `   ${padEnd("", 6)} ${style.gray(name)} ${style.gray(shares.absent_reason ?? `no ${shares.dimension} was attributed in the last ${label}`)}`,
          columns,
        ),
      );
      continue;
    }
    const drawn = list
      .map((share) => `${style.white(share.key)} ${percent(share.share)} ${style.gray(`(${share.worker_count})`)}`)
      .join(style.gray(" · "));
    // The unattributed are counted beside the list rather than dropped from it:
    // a share list that quietly excluded them would report 100% of a machine
    // while describing half of it.
    const rest = shares.unattributed_workers > 0
      ? ` ${style.gray(`· ${shares.unattributed_workers} unattributed`)}`
      : "";
    lines.push(truncate(`   ${padEnd("", 6)} ${style.gray(name)} ${drawn}${rest}`, columns));
  }
  return lines;
}

/**
 * A project label that still identifies the project at `width`. PURE.
 *
 * `owner/repo` truncated head-first turns every repository of one owner into the
 * same string — `reddb-io/re…` beside `reddb-io/re…` — which is worse than not
 * showing the column. The owner is the part every row shares, so the owner is
 * the part that goes.
 */
export function shortProject(label, width) {
  const text = String(label ?? "");
  if (text.length <= width) return text;
  const slash = text.lastIndexOf("/");
  return slash > 0 ? text.slice(slash + 1) : text;
}

/**
 * How wide each Worker column is at this pane width. PURE.
 *
 * The identity columns give way first and the vitals never do. A row cut at the
 * right edge loses the budget bar and the percentage — the two cells an operator
 * opened this pane for — while a shortened project name still reads.
 */
export function workerLayout(columns) {
  if (columns >= 108) return { id: 14, project: 26, state: 11, bar: 10, short: false };
  if (columns >= 92) return { id: 12, project: 18, state: 11, bar: 8, short: false };
  return { id: 10, project: 12, state: 5, bar: 6, short: true };
}

/** One Worker's row, plus the line it last published. PURE. */
export function renderWorkerRow(worker, { columns, selected, verbose, localProject, layout = workerLayout(columns) }) {
  const marker = selected ? style.brightRed(SELECTED) : " ";
  const mine = localProject != null && worker.project_label === localProject;

  const id = padEnd(truncate(worker.worker_id, layout.id), layout.id);
  const label = shortProject(worker.project_label, layout.project);
  const project = padEnd(truncate(mine ? style.brightCyan(label) : label, layout.project), layout.project);
  const reattached = worker.state === "reattached";
  const stateText = layout.short ? (reattached ? "reatt" : "run") : reattached ? "reattached" : "running";
  const state = (reattached ? style.cyan : style.green)(padEnd(stateText, layout.state));
  const uptime = padStart(duration(worker.uptime_ms), 6);

  const budget = worker.budget ?? {};
  const vitals = worker.vitals ?? {};
  const used = vitals.rss_bytes;
  const cap = budget.bytes;
  const usage = `${padStart(bytes(used), 7)}/${padEnd(cap == null ? style.gray("—") : bytes(cap), 7)}`;
  const bar = meter(budget.used_fraction, layout.bar);
  const share = padStart(percent(budget.used_fraction), 4);

  // An unmeasured Worker is not flagged: the row already carries `—` where its
  // RSS would be, and a second word saying the same thing is what pushes the
  // flags that are NOT redundant off the right edge of a narrow pane.
  const flags = [];
  if (!worker.isolated) flags.push(style.yellow("⚠ no unit"));
  if (vitals.rss_bytes != null && vitals.fresh === false) flags.push(style.yellow("⚠ stale sample"));
  if ((worker.warnings ?? []).length > 0) flags.push(style.yellow(`⚠ ${worker.warnings.length}`));

  const row = ` ${marker} ${id} ${project} ${state} ${uptime}  ${usage} ${bar} ${share}${flags.length ? `  ${flags.join(" ")}` : ""}`;
  const lines = [truncate(row, columns)];

  if (verbose) {
    const line = oneLine(worker.log?.last_line ?? "");
    if (line !== "") {
      const source = worker.log?.source === "rehydrated" ? style.gray(" (rehydrated)") : "";
      lines.push(truncate(`     ${style.gray("⤷")} ${style.dim(line)}${source}`, columns));
    }
  }

  return lines;
}

/** The Worker table, or the honest statement that there is none. PURE. */
export function renderWorkers(payload, { columns, selected, verbose, localProject, budgetRows }) {
  const workers = payload.workers ?? [];
  const lines = [rule("WORKERS", columns)];
  if (workers.length === 0) {
    lines.push(` ${style.gray("no Workers on this host — the machine is idle, and this is the daemon saying so")}`);
    return lines;
  }

  const layout = workerLayout(columns);
  lines.push(
    style.gray(
      truncate(
        `   ${padEnd("worker", layout.id)} ${padEnd("project", layout.project)} ${padEnd("state", layout.state)} ${padStart("up", 6)}` +
          `  ${padStart("rss", 7)}/${padEnd("budget", 7)} ${padEnd("used", layout.bar)} ${padStart("%", 4)}`,
        columns,
      ),
    ),
  );

  const visible = workers.slice(0, Math.max(1, budgetRows));
  visible.forEach((worker, index) => {
    lines.push(...renderWorkerRow(worker, { columns, selected: index === selected, verbose, localProject, layout }));
  });
  if (workers.length > visible.length) {
    lines.push(style.gray(` … ${workers.length - visible.length} more Worker(s) — the pane is short, not the host`));
  }
  return lines;
}

/** Each project's share of the machine, and the registrations behind them. PURE. */
export function renderProjects(payload, hostState, { columns, localProject, budgetRows }) {
  const projects = payload.projects ?? [];
  const registrations = hostState?.registrations ?? [];
  const known = payload.known_projects ?? [];
  const lines = [rule("PROJECTS", columns)];

  if (projects.length === 0 && registrations.length === 0) {
    const detail =
      known.length > 0
        ? `no Workers, but this host knows ${known.length} project(s): ${known.join(", ")}`
        : "this host holds no Workers and no registrations";
    lines.push(` ${style.gray(truncate(detail, columns - 2))}`);
    return lines;
  }

  lines.push(
    style.gray(
      truncate(`   ${padEnd("project", 30)} ${padStart("workers", 7)} ${padStart("declared", 9)} ${padStart("observed", 9)}  registration`, columns),
    ),
  );

  const byLabel = new Map(projects.map((project) => [project.project_label, project]));
  const labels = [...new Set([...projects.map((p) => p.project_label), ...registrations.map((r) => r.project_label)])].sort();

  const shown = labels.slice(0, Math.max(1, budgetRows));
  for (const label of shown) {
    const project = byLabel.get(label);
    const registration = registrations.find((entry) => entry.project_label === label);
    const name = label === localProject ? style.brightCyan(label) : label;
    const held = registration
      ? registration.renewal === "renewing"
        ? style.green(`renewing · target ${registration.target}`)
        : style.yellow(`running on · target ${registration.target}`)
      : style.gray("—");
    lines.push(
      truncate(
        `   ${padEnd(truncate(name, 30), 30)} ${padStart(String(project?.worker_count ?? 0), 7)}` +
          ` ${padStart(bytes(project?.declared_memory_bytes ?? null), 9)} ${padStart(bytes(project?.observed_rss_bytes ?? null), 9)}  ${held}`,
        columns,
      ),
    );
  }
  if (labels.length > shown.length) {
    lines.push(style.gray(` … ${labels.length - shown.length} more project(s) — the pane is short, not the host`));
  }
  return lines;
}

/** The tracker counts the daemon polls on every project's behalf. PURE. */
export function renderActivity(payload, { columns, localProject, budgetRows }) {
  const report = payload.repository_activity;
  const lines = [rule("PULL REQUESTS", columns)];

  if (!report || (report.projects ?? []).length === 0) {
    lines.push(` ${style.gray(truncate(report?.reason ?? "the daemon polls no repository", columns - 2))}`);
    return lines;
  }

  lines.push(
    style.gray(
      truncate(`   ${padEnd("repository", 34)} ${padStart("open PR", 8)} ${padStart("issues", 7)} ${padStart("closed", 7)}  state`, columns),
    ),
  );

  const visible = report.projects.slice(0, Math.max(1, budgetRows));
  for (const project of visible) {
    const counts = project.counts;
    const name = project.project_label === localProject ? style.brightCyan(project.repository) : project.repository;
    const state =
      project.outcome === "counted"
        ? project.stale
          ? style.yellow(`stale · ${duration(project.age_ms)} old`)
          : style.gray(`${duration(project.age_ms)} ago`)
        : project.outcome === "rate-limited"
          ? style.brightRed("rate-limited")
          : style.brightRed("unreachable");
    lines.push(
      truncate(
        `   ${padEnd(truncate(name, 34), 34)} ${padStart(counts ? style.bold(String(counts.open_pull_requests)) : "—", 8)}` +
          ` ${padStart(counts ? String(counts.open_issues) : "—", 7)} ${padStart(counts ? String(counts.recently_closed) : "—", 7)}  ${state}`,
        columns,
      ),
    );
  }

  if (report.projects.length > visible.length) {
    lines.push(style.gray(` … ${report.projects.length - visible.length} more repository(ies) — the pane is short, not the host`));
  }

  const limit = report.rate_limit ?? {};
  if (limit.exhausted || limit.remaining != null) {
    const quota = limit.exhausted
      ? style.brightRed("quota spent")
      : `${style.gray("quota")} ${limit.remaining} left`;
    const reset = limit.reset_at ? ` ${style.gray("· resets")} ${limit.reset_at.slice(11, 16)}Z` : "";
    lines.push(truncate(`   ${quota}${reset} ${style.gray("· one request for every project (ADR 0130 Am. 1)")}`, columns));
  }
  return lines;
}

/** The key map, which is the only documentation a pane can carry. PURE. */
export function renderFooter({ columns, state }) {
  const keys = [
    ["q", "quit"],
    ["r", "refresh"],
    ["j/k", "select"],
    ["l", "logs"],
    ["e", "events"],
    ["g", state.mode === "global" ? "local" : "global"],
    ["v", state.verbose ? "quiet" : "verbose"],
    ["?", "help"],
  ];
  const map = keys.map(([key, label]) => `${style.bold(key)} ${style.gray(label)}`).join("  ");
  return [rule(null, columns), truncate(` ${map}`, columns)];
}

/** The help overlay — one screen, no scrolling, no second page. PURE. */
export function renderHelp({ columns }) {
  const rows = [
    ["q / esc", "close this pane"],
    ["r", "re-read the daemon now, without waiting for the interval"],
    ["j / k / ↑ / ↓", "move the Worker selection"],
    ["l / enter", "open the selected Worker's log inside this pane"],
    ["e", "open the host event lane: birth, death, budget-kill"],
    ["g", "toggle between this project and the whole machine"],
    ["v", "toggle each Worker's last published line"],
    ["n", "send the current status as a herdr notification"],
    ["?", "close this help"],
  ];
  return [
    rule("KEYS", columns),
    ...rows.map(([key, label]) => truncate(`   ${padEnd(style.bold(key), 16)} ${style.gray(label)}`, columns)),
    blank(),
    rule("WHERE THIS COMES FROM", columns),
    truncate(`   ${style.gray("every fact is one read of the redskilled daemon over its unix socket:")}`, columns),
    truncate(`   ${style.gray("ops")} host-state ${style.gray("and")} statusline-payload ${style.gray("— this plugin never writes.")}`, columns),
    blank(),
    truncate(`   ${style.gray("config")} ${style.white("$HERDR_PLUGIN_CONFIG_DIR/config.json")}`, columns),
    truncate(`   ${style.gray("socket")} ${style.white("$REDSKILLED_SOCKET")} ${style.gray("overrides the derivation")}`, columns),
  ];
}

/** What to draw when nothing answered — an absence, said plainly. PURE. */
export function renderUnreachable(snapshot, { columns, socketPath, source }) {
  return [
    rule("NO HOST ANSWERED", columns),
    truncate(` ${style.gray("socket")} ${style.white(socketPath)}`, columns),
    truncate(` ${style.gray("resolved")} ${source}`, columns),
    blank(),
    truncate(` ${style.gray(snapshot.error?.message ?? "the daemon did not answer")}`, columns),
    blank(),
    truncate(` ${style.gray("An empty host state must mean an idle machine, never a failed lookup — so this")}`, columns),
    truncate(` ${style.gray("pane refuses to draw zeros it did not read. Nothing here starts the daemon:")}`, columns),
    truncate(` ${style.gray("a pane opening on session restore must not spawn a machine-wide singleton.")}`, columns),
    blank(),
    truncate(` ${style.gray("Bring one up with")} ${style.white("redskilled provision")} ${style.gray("or check")} ${style.white("redskilled provision --check")}${style.gray(".")}`, columns),
  ];
}

/**
 * One frame of the overview. PURE.
 *
 * Sections are laid out against the pane's actual height, and what does not fit
 * is stated rather than silently cut: a viewer that dropped rows without saying
 * so would let an operator read a busy machine as a quiet one.
 */
export function renderDashboard({ snapshot, state, size, localProject, now = new Date().toISOString(), socket }) {
  const { columns, rows } = size;
  const lines = [];

  lines.push(...renderHeader(snapshot, { columns, now }));

  if (!snapshot.reachable) {
    lines.push(...renderUnreachable(snapshot, { columns, socketPath: socket?.socketPath ?? "?", source: socket?.source ?? "?" }));
    lines.push(...renderFooter({ columns, state }));
    return lines;
  }

  if (state.view === "help") {
    lines.push(...renderHelp({ columns }));
    lines.push(...renderFooter({ columns, state }));
    return lines;
  }

  const payload = snapshot.payload;
  lines.push(rule(null, columns));
  lines.push(...renderHost(payload, { columns }));
  // Above the tables, because the rates are what the host section is for — how
  // much of this machine is in use, and how fast it is spending it — and they
  // cost a fixed handful of rows the budget below can therefore count.
  lines.push(...renderMetrics(payload, { columns }));

  // Budget the remaining rows across the three tables rather than letting the
  // first one eat the pane: an operator opening this for the PR counts must not
  // have to scroll past every Worker to reach them. The two short tables are
  // served first and only up to what they actually need, so a busy machine
  // spends its rows on Workers and a quiet one does not pad two empty tables.
  const fixed = lines.length + 2 /* footer */ + 3 /* section rules */ + 3 /* headers */;
  const free = Math.max(6, rows - fixed);
  const projectLabels = new Set([
    ...(payload.projects ?? []).map((project) => project.project_label),
    ...(snapshot.hostState?.registrations ?? []).map((registration) => registration.project_label),
  ]);
  const activityRows = Math.min(
    Math.max(1, (payload.repository_activity?.projects ?? []).length),
    Math.max(2, Math.floor(free * 0.32)),
  );
  const projectRows = Math.min(Math.max(1, projectLabels.size), Math.max(2, Math.floor(free * 0.28)));
  const workerLines = Math.max(1, free - activityRows - projectRows);
  const workerRows = state.verbose ? Math.max(1, Math.floor(workerLines / 2)) : workerLines;

  lines.push(...renderWorkers(payload, {
    columns,
    selected: state.selected,
    verbose: state.verbose,
    localProject,
    budgetRows: workerRows,
  }));
  lines.push(...renderProjects(payload, snapshot.hostState, { columns, localProject, budgetRows: projectRows }));
  lines.push(...renderActivity(payload, { columns, localProject, budgetRows: activityRows }));

  if (state.message) lines.push(truncate(` ${style.brightCyan(state.message)}`, columns));

  lines.push(...renderFooter({ columns, state }));
  return lines;
}
