/**
 * dashboard — the richest density: the payload given a vertical dimension.
 *
 * **One implementation, four densities.** The statusline pair settled drift for
 * one line by making the string a pure function of the payload; ADR 0132 decision
 * 1 finishes the argument — four surfaces at four densities cannot share a
 * string, and they must not each own a layout. So the table is drawn HERE, beside
 * the line, from the same selection and the same marks, and a surface prints.
 *
 * **The string is a pure function of the payload.** Nothing here reads a clock, a
 * directory or an environment variable; the elapsed figures are subtracted from
 * the payload's own `generated_at`, so the dashboard and the statusline beside it
 * can only disagree if a pure function is impure.
 *
 * **Nothing here learns the pipeline.** The progress bar is drawn from the two
 * integers a project published (`phase_index`, `phase_total`) and from nothing
 * else. A renderer that knew what `coding` or `validating` meant would be
 * carrying castle semantics, which ADR 0130 rule 3 keeps out of the host lane
 * entirely — and this module runs on both sides of it.
 *
 * **Host-side session facts stay absent rather than faked.** The context window
 * and the Pro/Max 5h/7d usage windows arrive from a Claude Code stdin payload
 * that never reaches the daemon. The header carries the windows the daemon DOES
 * own — the memory ceiling and the Worker slots — and says nothing about the ones
 * it does not, because a plausible zero is worse than a missing column.
 */
import { clamp, formatBytes, formatCount, formatDuration, formatRate, pad, width } from "./format.js";
import {
  BUDGET_BAND_MARK,
  BUDGET_SPENT_MARK,
  DEATH_MARK,
  ENGINE_BEHIND_MARK,
  LAPSED_MARK,
  UNREGISTERED_MARK,
} from "./marks.js";
import {
  REDSKILLED_RENDER_DISPLAY_ABSENT,
  type RedskilledRenderDeaths,
  type RedskilledRenderEngine,
  type RedskilledRenderMetrics,
  type RedskilledRenderMetricsWindow,
  type RedskilledRenderPayload,
  type RedskilledRenderWorker,
  type RedskilledRenderWorkerDisplay,
  type RedskilledStatuslineMode,
  workerElapsedMs,
} from "./payload.js";
import {
  resolveStatuslineProjectMatch,
  selectRenderWorkers,
  type RedskilledStatuslineProjectMatch,
} from "./select.js";

/** The row columns, in the order the statusline's per-worker line prints them. */
export const REDSKILLED_DASHBOARD_COLUMNS = [
  "wid",
  "run",
  "org",
  "iss",
  "bar",
  "phase",
  "elapsed",
  "eta",
  "hb",
  "loc",
  "tks",
  "ctx",
  "tls",
  "rsn",
  "txt",
] as const;

export type RedskilledDashboardColumn = (typeof REDSKILLED_DASHBOARD_COLUMNS)[number];

/** One row's cells, before alignment. A cell nothing was published for is `""`. */
export type RedskilledDashboardCells = Record<RedskilledDashboardColumn, string>;

export interface RedskilledDashboardRow {
  readonly worker_id: string;
  readonly project_label: string;
  /** True when this Worker belongs to the project the reading session named. */
  readonly mine: boolean;
  readonly cells: RedskilledDashboardCells;
  /** The finished, column-aligned line. A surface prints this and adds nothing. */
  readonly line: string;
}

/** The repo-global counts the header carries, each `null` when unpolled. */
export interface RedskilledDashboardCounts {
  readonly open_pull_requests: number | null;
  /** Pull requests and Issues closed inside the poller's window — the `cpr` cell. */
  readonly recently_closed: number | null;
  readonly open_issues: number | null;
  /** True when the counts are older than the poller's own staleness window. */
  readonly stale: boolean;
}

/**
 * The windows the daemon owns, as fractions.
 *
 * Named `windows` because that is the header slot the statusline spends on the
 * Pro/Max rate limits. Those are host-side and unknowable here; these two are the
 * ceilings the daemon actually enforces, so the slot carries a real answer
 * rather than an empty one.
 */
export interface RedskilledDashboardWindows {
  readonly memory_used_fraction: number | null;
  readonly memory_used_bytes: number;
  readonly memory_ceiling_bytes: number | null;
  readonly worker_count: number;
  readonly worker_ceiling: number | null;
}

export interface RedskilledDashboardHeader {
  /** The repository or project this view is standing in; `null` when unresolved. */
  readonly repo: string | null;
  readonly project: string | null;
  readonly project_match: RedskilledStatuslineProjectMatch;
  /** The daemon's version — the one version the answering process can state. */
  readonly version: string;
  /**
   * Which engine answered and whether it is current; `null` on an older daemon.
   *
   * Beside `version` rather than replacing it: `version` is what a surface prints
   * with no interpretation, and this is the comparison behind the `⇡`. A `null`
   * here is "this daemon predates the block", never "it is up to date".
   */
  readonly engine: RedskilledRenderEngine | null;
  /** What this host could not explain; `null` when nothing has reaped. */
  readonly deaths: RedskilledRenderDeaths | null;
  /**
   * The rates the daemon derived; `null` on a daemon that derives none.
   *
   * Carried in full beside the line even though only a few figures fit in it: a
   * surface reading the structure gets both windows and both share dimensions,
   * and a surface printing the line gets whatever the width allowed. `null` here
   * is "this daemon has no metrics block", never "this machine did nothing".
   */
  readonly metrics: RedskilledRenderMetrics | null;
  /** `runner model effort`, from the first Worker that published one; else `null`. */
  readonly model: string | null;
  readonly windows: RedskilledDashboardWindows;
  readonly counts: RedskilledDashboardCounts;
  readonly stale: boolean;
  readonly age_ms: number | null;
  /** The finished header line — the summary a status bar shows on its own. */
  readonly line: string;
}

export interface RedskilledDashboard {
  readonly version: 1;
  readonly generated_at: string;
  readonly mode: RedskilledStatuslineMode;
  readonly project: string | null;
  readonly columns: readonly RedskilledDashboardColumn[];
  readonly header: RedskilledDashboardHeader;
  readonly rows: readonly RedskilledDashboardRow[];
  /**
   * Every line to print, the header first.
   *
   * A list rather than one string with newlines in it, for the reason the
   * statusline render gives: a surface that had to split on `\n` to know how many
   * rows to reserve would be parsing the render.
   */
  readonly lines: readonly string[];
  /** Workers the row budget left out — stated, never silently dropped. */
  readonly hidden_row_count: number;
  readonly stale: boolean;
}

export interface RedskilledDashboardOptions {
  readonly mode: RedskilledStatuslineMode;
  /** The project this session belongs to; `null` when it declared none. */
  readonly project: string | null;
  /** The hard ceiling in characters. No line exceeds it. */
  readonly maxWidth: number;
  /** How many Worker rows may be drawn before the rest are counted instead. */
  readonly maxRows: number;
}

export const REDSKILLED_DASHBOARD_DEFAULTS: RedskilledDashboardOptions = {
  mode: "local",
  project: null,
  maxWidth: 200,
  maxRows: 16,
};

const GUTTER = "  ";
const BAR_DONE = "█";
const BAR_CURSOR = "▶";
const BAR_FAILED = "✗";
const BAR_AHEAD = "░";

/**
 * The finished dashboard. PURE — payload and options in, header and rows out.
 *
 * Rows are laid out against the widest cell in each column so the table reads as
 * a table at any Worker count, and the whole thing is clamped to `maxWidth`
 * afterwards: a row cut mid-cell still begins with the identity columns, which
 * are the ones that make the remainder attributable.
 */
export function renderRedskilledDashboard(
  payload: RedskilledRenderPayload,
  options: RedskilledDashboardOptions = REDSKILLED_DASHBOARD_DEFAULTS,
): RedskilledDashboard {
  const match = resolveStatuslineProjectMatch(payload, options.project);
  const selected = selectRenderWorkers(payload, options);
  const visible = selected.slice(0, Math.max(0, Math.floor(options.maxRows)));
  const cells = visible.map((worker) => workerCells(worker, options, payload.generated_at));
  const widths = columnWidths(cells);

  const rows: RedskilledDashboardRow[] = visible.map((worker, index) => ({
    worker_id: worker.worker_id,
    project_label: worker.project_label,
    mine: options.project != null && worker.project_label === options.project,
    cells: cells[index]!,
    line: clamp(formatRow(cells[index]!, widths), options.maxWidth),
  }));

  const header = buildHeader(payload, options, selected, match);
  const hidden = selected.length - visible.length;
  const lines = [header.line, ...rows.map((row) => row.line)];
  if (hidden > 0) {
    lines.push(clamp(`… ${hidden} more Worker(s) — the row budget is short, not the host`, options.maxWidth));
  }
  // BELOW the Workers, because a death is the answer to a question asked after
  // the table has been read: the header already carries the count and the class,
  // and these lines are the receipt behind it — one per verdict, naming what died
  // and the evidence the verdict rests on.
  lines.push(...deathLines(payload, options));
  // ABOVE nothing and BELOW everything, but never absent when it matters: a
  // spent or reserved budget is drawn even on a dashboard with no Workers and no
  // deaths, because "the queue looks empty" and "we are out of quota" produce the
  // same empty table and must not produce the same screen (#3095).
  lines.push(...balanceLines(payload, options));

  return {
    version: 1,
    generated_at: payload.generated_at,
    mode: options.mode,
    project: options.project,
    columns: REDSKILLED_DASHBOARD_COLUMNS,
    header,
    rows,
    lines,
    hidden_row_count: Math.max(0, hidden),
    stale: payload.staleness.stale,
  };
}

/**
 * One Worker's cells, in the statusline's own vocabulary. PURE.
 *
 * A field the project never published renders as an EMPTY cell rather than as a
 * zero: `tks=0` is a Worker that has spent nothing, and a Worker whose bundle
 * publishes no display record has spent an unknown amount.
 */
function workerCells(
  worker: RedskilledRenderWorker,
  options: RedskilledDashboardOptions,
  generatedAt: string,
): RedskilledDashboardCells {
  const display = worker.display ?? REDSKILLED_RENDER_DISPLAY_ABSENT;
  const run = [display.runner, display.model, display.effort].filter((part): part is string => Boolean(part)).join(" ");
  return {
    wid: options.mode === "global" ? `${worker.project_label}:${worker.worker_id}` : worker.worker_id,
    run: run === "" ? "" : `run=${run}`,
    org: display.origin == null ? "" : `org=${display.origin}`,
    iss: display.issue == null ? "" : `iss=${display.issue}`,
    bar: progressBar(display),
    phase: [display.phase, display.step].filter((part): part is string => Boolean(part)).join("·"),
    elapsed: formatDuration(workerElapsedMs(worker, generatedAt)),
    // A Worker whose project will not estimate gets NO cell — not `eta=—`, and
    // certainly not a figure this module could have extrapolated off the bar
    // beside it. The absence is the honest answer and it is legible as one.
    eta: display.eta == null ? "" : `eta=${formatDuration(display.eta * 1000)}`,
    hb: `hb=${display.heartbeat ?? "?"}`,
    loc: formatSignedPair(display.added, display.removed),
    tks: display.tokens == null ? "" : `tks=${formatCount(display.tokens)}`,
    ctx: display.context == null ? "" : `ctx=${formatCount(display.context)}`,
    tls: display.tools == null ? "" : `tls=${display.tools}`,
    rsn: display.reasoning == null ? "" : `rsn=${display.reasoning}`,
    txt: display.text == null ? "" : `txt=${display.text}`,
  };
}

/**
 * The pipeline bar, drawn from two integers and no vocabulary. PURE.
 *
 * `index` completed cells, one cursor, and the rest ahead. A project that
 * published no position gets no bar at all — a bar with an invented cursor would
 * put a Worker somewhere in a pipeline this module cannot see.
 */
export function progressBar(display: RedskilledRenderWorkerDisplay): string {
  const total = display.phase_total;
  const index = display.phase_index;
  if (total == null || total <= 0 || index == null || index < 0) return "";
  const done = Math.min(Math.floor(index), Math.floor(total));
  if (done >= total) return BAR_DONE.repeat(Math.floor(total));
  const cursor = display.failed ? BAR_FAILED : BAR_CURSOR;
  return `${BAR_DONE.repeat(done)}${cursor}${BAR_AHEAD.repeat(Math.floor(total) - done - 1)}`;
}

/**
 * The header line — the one row that is drawn whatever else is dropped. PURE.
 *
 * It is also the whole answer a status bar shows, which is why it repeats the
 * host totals rather than relying on the table beneath it: a summary that only
 * made sense with the rows visible would be useless in the one place it is shown
 * alone.
 */
function buildHeader(
  payload: RedskilledRenderPayload,
  options: RedskilledDashboardOptions,
  selected: readonly RedskilledRenderWorker[],
  match: RedskilledStatuslineProjectMatch,
): RedskilledDashboardHeader {
  const activity = (payload.repository_activity?.projects ?? []).find(
    (project) => project.project_label === options.project,
  );
  const counts: RedskilledDashboardCounts = {
    open_pull_requests: activity?.counts?.open_pull_requests ?? null,
    recently_closed: activity?.counts?.recently_closed ?? null,
    open_issues: activity?.counts?.open_issues ?? null,
    stale: activity?.stale === true,
  };
  const windows: RedskilledDashboardWindows = {
    memory_used_fraction: payload.host.ceiling_used_fraction,
    memory_used_bytes: payload.host.consumption.memory_bytes,
    memory_ceiling_bytes: payload.host.ceiling.memory_bytes,
    worker_count: payload.host.worker_count,
    worker_ceiling: payload.host.ceiling.worker_count,
  };
  const model = firstPublishedModel(selected);
  const repo = activity?.repository ?? options.project;

  const engine = payload.engine ?? null;
  const version = engine?.running_version ?? payload.daemon.daemon_version;
  const deaths = payload.deaths ?? null;
  const metrics = payload.metrics ?? null;

  // The version carries its own currency mark rather than a separate token: a
  // surface reading `v3.1.0` on its own cannot tell a current daemon from one
  // three releases behind, and that is the whole of "is my engine current".
  const parts: string[] = [
    `» ${repo ?? "host"} v${version}${engine != null && engine.current === false ? ENGINE_BEHIND_MARK : ""}`,
  ];
  if (match === "unregistered" || match === "name-only") parts.push(UNREGISTERED_MARK);
  if (match === "lapsed") parts.push(LAPSED_MARK);
  if (model != null) parts.push(model);
  parts.push(`wrk=${selected.length}/${payload.host.worker_count}`);
  parts.push(
    windows.worker_ceiling == null ? "slots=∞" : `slots=${windows.worker_count}/${windows.worker_ceiling}`,
  );
  parts.push(memoryWindow(windows));
  if (counts.open_pull_requests != null) parts.push(`prs=${counts.open_pull_requests}`);
  if (counts.recently_closed != null) parts.push(`cpr=${counts.recently_closed}`);
  if (counts.open_issues != null) parts.push(`iss=${counts.open_issues}`);
  if (counts.stale) parts.push("!counts stale");
  // The rates go here, where a status bar still reads them, and they are the
  // FIRST thing dropped when the line does not fit — see below. Everything
  // before them answers "is this machine healthy"; the rates answer "how fast is
  // it going", which is the question that can wait for the table.
  const rates = metrics == null ? null : compactRates(metrics.hour);
  if (rates != null) parts.push(rates);
  // Beside the counts rather than under the table, because a death is a fact
  // about the machine and not about one project's Workers — and the header is
  // the whole of what a status bar shows.
  if (deaths != null && deaths.count > 0 && deaths.latest != null) {
    parts.push(`${DEATH_MARK}${deaths.count} ${deaths.latest.sender_class}`);
  }
  if (payload.staleness.stale) {
    const age = payload.staleness.age_ms;
    parts.push(age == null ? "!unmeasured" : `!stale ${Math.round(age / 1000)}s`);
  }

  // The rates are optional in the literal sense: a header clamped mid-figure
  // reads as a smaller number than the one measured (`tk/m=1.2` for 1.2k), so
  // they are dropped whole rather than truncated. Every other part survived a
  // narrow pane before this one existed and still does.
  const full = parts.join(" · ");
  const line = rates != null && width(full) > options.maxWidth
    ? parts.filter((part) => part !== rates).join(" · ")
    : full;

  return {
    repo,
    project: options.project,
    project_match: match,
    version,
    engine,
    deaths,
    metrics,
    model,
    windows,
    counts,
    stale: payload.staleness.stale,
    age_ms: payload.staleness.age_ms,
    line: clamp(line, options.maxWidth),
  };
}

/**
 * The rates a one-line budget can carry: `tk/m=1.2k tl/m=8 iss/h=3`. PURE.
 *
 * The HOUR window and not the day, because a header is read to learn what the
 * machine is doing NOW, and a 24h average is the figure least able to answer
 * that. The day window rides on the structure beside the line for the surfaces
 * with room to draw both.
 *
 * **A figure the daemon could not derive is left out, never printed as zero.**
 * `tk/m=0` is a machine that spent nothing, and a window with no heartbeat in it
 * is a machine nobody measured; a header with no room to explain the difference
 * must not assert the wrong one. A window that derived nothing at all yields
 * `null` here and costs the line no characters.
 */
export function compactRates(window: RedskilledRenderMetricsWindow): string | null {
  const parts: string[] = [];
  if (window.tokens_per_min.value != null) parts.push(`tk/m=${formatRate(window.tokens_per_min.value)}`);
  if (window.tools_per_min.value != null) parts.push(`tl/m=${formatRate(window.tools_per_min.value)}`);
  if (window.issues_per_hour.value != null) parts.push(`iss/h=${formatRate(window.issues_per_hour.value)}`);
  // One share and not the list: the leader is what a glance takes from a
  // distribution, and the rest need a column the header does not have.
  const leader = window.runner_share.shares[0];
  if (leader != null) parts.push(`${leader.key}=${Math.round(leader.share * 100)}%`);
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * The budget posture, drawn only when it is something an operator must act on.
 *
 * An `open` balance draws nothing: a line that is always there is a line nobody
 * reads, and the whole value of this one is that its presence means something.
 * `unknown` is silent for the same reason it opens the gate — the daemon has not
 * asked, which is a fact about the observer and not about the token.
 */
function balanceLines(
  payload: RedskilledRenderPayload,
  options: RedskilledDashboardOptions,
): readonly string[] {
  const balance = payload.github_balance;
  if (balance == null) return [];
  if (balance.posture !== "spent" && balance.posture !== "reserved") return [];
  const mark = balance.posture === "spent" ? BUDGET_SPENT_MARK : BUDGET_BAND_MARK;
  const age = balance.age_ms == null ? "" : ` (${Math.round(balance.age_ms / 1000)}s ago)`;
  return [clamp(`${mark} github budget ${balance.posture}${age} — ${balance.reason}`, options.maxWidth)];
}

/**
 * One line per posed death — the receipt behind the header's count. PURE.
 *
 * Each line names WHAT died, WHO ended it, HOW SURE the reaper is and the fact
 * the verdict rests on, because those four are the whole of "why did it die" and
 * a reader who has to open a lane to get them is a reader who does not. The
 * confidence travels with the class and is never dropped: `oomd/low` and
 * `oomd/high` send an operator to different places.
 *
 * Nothing is drawn when the block is absent or empty — a dashboard that printed
 * `deaths 0` would spend a row telling a healthy machine it is healthy.
 */
function deathLines(
  payload: RedskilledRenderPayload,
  options: RedskilledDashboardOptions,
): readonly string[] {
  const deaths = payload.deaths;
  if (deaths == null || deaths.count <= 0) return [];
  const lines = deaths.recent.map((death) =>
    clamp(
      `${DEATH_MARK} ${death.kind} ${death.id} pid=${death.pid}` +
        ` ${death.sender_class}/${death.confidence} phase=${death.last_phase}` +
        (death.signal == null ? "" : ` signal=${death.signal}`) +
        (death.evidence == null ? "" : ` — ${death.evidence}`),
      options.maxWidth,
    ),
  );
  const hidden = deaths.count - deaths.recent.length;
  if (hidden > 0) {
    lines.push(clamp(`… ${hidden} more posed death(s) — the lane holds them all`, options.maxWidth));
  }
  return lines;
}

/** `mem=1.2G/8G 15%`, or the observed figure alone when nothing caps it. PURE. */
function memoryWindow(windows: RedskilledDashboardWindows): string {
  if (windows.memory_ceiling_bytes == null || windows.memory_ceiling_bytes <= 0) {
    return `mem=${formatBytes(windows.memory_used_bytes)}`;
  }
  const percent =
    windows.memory_used_fraction == null ? "" : ` ${Math.round(windows.memory_used_fraction * 100)}%`;
  return `mem=${formatBytes(windows.memory_used_bytes)}/${formatBytes(windows.memory_ceiling_bytes)}${percent}`;
}

/**
 * The first `runner model effort` any listed Worker published. PURE.
 *
 * First rather than merged: a host running two runners at once has no single
 * answer, and a header that invented one would be stating something no Worker
 * said. The per-Worker `run=` cells carry the truth for each row.
 */
function firstPublishedModel(workers: readonly RedskilledRenderWorker[]): string | null {
  for (const worker of workers) {
    const display = worker.display;
    if (display == null) continue;
    const parts = [display.runner, display.model, display.effort].filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join("·");
  }
  return null;
}

/** `loc=+12 -3`; empty when the project published neither side. PURE. */
function formatSignedPair(added: number | null, removed: number | null): string {
  if (added == null && removed == null) return "";
  const parts: string[] = [];
  if (added != null && added > 0) parts.push(`+${added}`);
  if (removed != null && removed > 0) parts.push(`-${removed}`);
  return `loc=${parts.length > 0 ? parts.join(" ") : "0"}`;
}

/**
 * True when `value` is a dashboard this surface can print — fail-closed. PURE.
 *
 * The check stops at `lines` and the header's own line, because those are what a
 * surface prints; a daemon that grew a field this consumer has never heard of
 * still serves a printable answer, and rejecting it would blank a pane over
 * version skew the host-scoped daemon exists to stop managing (ADR 0130 rule 3).
 */
export function isRedskilledDashboard(value: unknown): value is RedskilledDashboard {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const dashboard = value as Record<string, unknown>;
  const header = dashboard.header as Record<string, unknown> | undefined;
  return dashboard.version === 1 &&
    typeof dashboard.generated_at === "string" &&
    Array.isArray(dashboard.columns) &&
    Array.isArray(dashboard.rows) &&
    Array.isArray(dashboard.lines) &&
    dashboard.lines.every((line) => typeof line === "string") &&
    typeof dashboard.stale === "boolean" &&
    header != null && typeof header === "object" && typeof header.line === "string";
}

function columnWidths(rows: readonly RedskilledDashboardCells[]): Record<RedskilledDashboardColumn, number> {
  const widths = Object.fromEntries(REDSKILLED_DASHBOARD_COLUMNS.map((column) => [column, 0])) as Record<
    RedskilledDashboardColumn,
    number
  >;
  for (const row of rows) {
    for (const column of REDSKILLED_DASHBOARD_COLUMNS) {
      widths[column] = Math.max(widths[column], width(row[column]));
    }
  }
  return widths;
}

/**
 * One aligned row. A column no row filled costs nothing at all. PURE.
 *
 * The trailing edge is trimmed rather than padded: a table whose rows all end in
 * fourteen spaces looks identical in a terminal and is not identical in an
 * editor's diff, a clipboard, or a test assertion.
 */
function formatRow(
  cells: RedskilledDashboardCells,
  widths: Record<RedskilledDashboardColumn, number>,
): string {
  const parts = REDSKILLED_DASHBOARD_COLUMNS.filter((column) => widths[column] > 0).map((column) =>
    pad(cells[column], widths[column]),
  );
  return parts.join(GUTTER).replace(/\s+$/, "");
}
