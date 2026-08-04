/**
 * line — the statusline density: one head, then one row per Worker.
 *
 * **The string is a pure function of the payload.** That purity is the whole
 * mitigation for having four surfaces at all (ADR 0132 decision 1): a renderer
 * that could reach for one extra fact — a directory listing, a clock, an
 * environment variable — would be a second authority on a question the payload
 * already answers, and the surfaces would eventually describe different machines.
 * Everything this function needs is an argument, so a fixture payload renders
 * byte-identically to a live one.
 *
 * **The default mode is quiet: only the local project's Workers.** The common
 * case is one operator in one repository, and a line that listed every project
 * by default would make the common case pay for the rare one. `global` lists
 * every project's Workers and names the owner of each, because an anonymous
 * Worker on a busy machine is the exact thing the mode exists to fix.
 *
 * **`verbose` gives each listed Worker a second line: the last line it logged.**
 * That line arrives inside the payload, published by the Worker on its heartbeat,
 * so a verbose global view still costs ONE read and opens no project's files. The
 * renderer treats it as text to fit on a line and never as a fact to interpret:
 * whitespace is collapsed so one Worker cannot break the line contract, and the
 * width clamp is the same one every other line answers to. A Worker that has
 * logged nothing gets no second line at all — a blank one would be a render
 * defect wearing the shape of information.
 *
 * **Width degrades cells, never Workers.** A selected Worker keeps its row at
 * every terminal width; cells leave from the right until the row fits. Count
 * budgets may still choose a project or host aggregate, but width alone never
 * erases the identities the operator came here to see.
 */
import {
  REDSKILLED_DASHBOARD_COLUMNS,
  workerCells,
  type RedskilledDashboardCells,
  type RedskilledDashboardColumn,
} from "./dashboard.js";
import { clamp, flattenPublishedLine, formatBytes, formatDuration, pad, width } from "./format.js";
import {
  BUDGET_BAND_MARK,
  BUDGET_SPENT_MARK,
  DEATH_MARK,
  ENGINE_BEHIND_MARK,
  LOG_LINE_MARK,
  REDSKILLED_RENDER_ABSENCE,
  UNREGISTERED_MARK,
} from "./marks.js";
import { BAR_AHEAD, BAR_CURRENT, BAR_DONE, BOLD, KEY, NOBG, NOBOLD, RED, RESET, SOFT, VAL } from "./palette.js";
import type {
  RedskilledRenderPayload,
  RedskilledRenderProject,
  RedskilledRenderWorker,
  RedskilledStatuslineMode,
} from "./payload.js";
import {
  detailLadder,
  resolveStatuslineProjectMatch,
  selectRenderProjects,
  selectRenderWorkers,
  type RedskilledStatuslineDetail,
  type RedskilledStatuslineProjectMatch,
} from "./select.js";
import {
  composeRepair,
  noRepair,
  registrationRepair,
  type RepairAction,
} from "@reddb-io/shared/repair.js";

export interface RedskilledStatuslineOptions {
  readonly mode: RedskilledStatuslineMode;
  /** The project this session belongs to; `null` when it declared none. */
  readonly project: string | null;
  /** How many Worker entries may be listed before the line drops to projects. */
  readonly maxWorkers: number;
  /** How many project entries may be listed before the line drops to the host. */
  readonly maxProjects: number;
  /** The hard ceiling in characters. The line never exceeds it. */
  readonly maxWidth: number;
  readonly separator: string;
  /** Give each listed Worker a second line carrying its last logged line. */
  readonly verbose: boolean;
}

/**
 * What was rendered, and at what detail.
 *
 * `detail` is stated rather than inferred from the text: a consumer that had to
 * detect degradation by counting separators would be parsing the rendered line,
 * which is the failure this whole module exists to remove.
 */
export interface RedskilledStatuslineRender {
  readonly version: 1;
  /** The statusline itself — the first line, and the only one when quiet. */
  readonly line: string;
  /**
   * Every line to print, `line` first.
   *
   * A list rather than one string with newlines in it: a host that had to split
   * on `\n` to know how many rows to reserve would be parsing the render, which
   * is the one thing this surface exists to spare it.
   */
  readonly lines: readonly string[];
  readonly verbose: boolean;
  readonly mode: RedskilledStatuslineMode;
  readonly project: string | null;
  /**
   * Whether this host knows {@link project}, stated rather than left to be read
   * off the line. A consumer that had to notice the word `unknown` in the text
   * would be parsing the render, which is the failure this surface removes.
   */
  readonly project_match: RedskilledStatuslineProjectMatch;
  /** Pasteable cure for a repairable empty state, composed with the head text. */
  readonly repair?: RepairAction | "none";
  /** Why this state deliberately has no callable cure. */
  readonly repair_reason?: string;
  readonly detail: RedskilledStatuslineDetail;
  /** True when the line lost detail to the width or the count budgets. */
  readonly degraded: boolean;
  readonly stale: boolean;
  /** The instant of the payload this line was rendered from. */
  readonly generated_at: string;
}

/** The defaults a project overrides in config, and a flag overrides again. */
export const REDSKILLED_STATUSLINE_DEFAULTS: RedskilledStatuslineOptions = {
  mode: "local",
  project: null,
  maxWorkers: 4,
  maxProjects: 4,
  maxWidth: 120,
  separator: " · ",
  verbose: false,
};

/**
 * The finished statusline. PURE — payload and options in, printable rows out.
 *
 * Count budgets choose the detail. At Worker detail the head and every Worker
 * get their own row; a narrow width removes whole cells from the right instead
 * of replacing all Workers with an aggregate.
 */
export function renderRedskilledStatusline(
  payload: RedskilledRenderPayload,
  options: RedskilledStatuslineOptions = REDSKILLED_STATUSLINE_DEFAULTS,
): RedskilledStatuslineRender {
  const match = resolveStatuslineProjectMatch(payload, options.project);
  const workers = selectRenderWorkers(payload, options);
  const projects = selectRenderProjects(payload, options);
  const unmatched = unmatchedHead(payload, options.project, match);
  const head = renderHead(payload, options, workers, match, unmatched.prose);

  const ladder = detailLadder({
    mode: options.mode,
    maxWorkers: options.maxWorkers,
    maxProjects: options.maxProjects,
    workers,
    projects,
  });
  let chosen: { detail: RedskilledStatuslineDetail; line: string } = {
    detail: "host",
    line: head,
  };
  for (const detail of ladder) {
    const line = detail === "workers"
      ? head
      : compose(head, projectBody(detail, projects), options.separator);
    chosen = { detail, line };
    // Worker rows have their own width ladder below. Aggregate detail retains
    // the old all-or-nothing rule so a project figure is never cut in half.
    if (detail === "workers" || width(line) <= options.maxWidth) break;
  }
  // Even the host aggregate can outgrow a very narrow line; a clamp is the last
  // resort and never the normal path, so it keeps the ellipsis visible.
  const line = clamp(chosen.line, options.maxWidth);
  const table = chosen.detail === "workers"
    ? renderWorkerRows(workers, options, payload.generated_at)
    : { lines: [] as readonly string[], degraded: false };
  // A verbose line follows the Worker row it annotates. An aggregate gets no
  // Worker log because there is no attributable row for that log to belong to.
  const workerLines = chosen.detail === "workers"
    ? workers.flatMap((worker, index) => {
        const logged = options.verbose ? workerLogLine(worker, options) : null;
        return logged == null ? [table.lines[index]!] : [table.lines[index]!, logged];
      })
    : [];
  // Degradation is measured against the richest detail this payload COULD have
  // shown, not against the richest one the budgets allowed: a line that dropped
  // the Workers because `max_workers` said so is degraded in the only sense a
  // reader cares about — there is more to see than is on the line.
  const richest: RedskilledStatuslineDetail = workers.length > 0 ? "workers" : "host";

  return {
    version: 1,
    line,
    lines: [line, ...workerLines],
    verbose: options.verbose,
    mode: options.mode,
    project: options.project,
    project_match: match,
    ...(unmatched.repair === undefined ? {} : { repair: unmatched.repair }),
    ...(unmatched.repair_reason === undefined
      ? {}
      : { repair_reason: unmatched.repair_reason }),
    detail: chosen.detail,
    degraded: chosen.detail !== richest || line !== chosen.line || table.degraded,
    stale: payload.staleness.stale,
    generated_at: payload.generated_at,
  };
}

/**
 * The size a render may reach, as three numbers a test can pin.
 *
 * Stated as a function of the OPTIONS alone, never of the host: that is the whole
 * claim. A machine holding five hundred Workers must hand a statusline consumer
 * the same-sized answer a machine holding one does, because the consumer is a
 * single row of a terminal refreshed every sixty seconds — the 571 KB document
 * #2928 found in that path was sized by the host instead.
 */
export interface RedskilledStatuslineBound {
  /** The head, one row per listed Worker, plus optional log rows. */
  readonly max_lines: number;
  readonly max_line_width: number;
  /** Every rendered line together, separators included. */
  readonly max_characters: number;
}

/** What {@link renderRedskilledStatusline} may at most produce. PURE. */
export function redskilledStatuslineBound(
  options: RedskilledStatuslineOptions = REDSKILLED_STATUSLINE_DEFAULTS,
): RedskilledStatuslineBound {
  // Worker detail exists only while there are no more Workers than the count
  // budget, so that budget bounds both table rows and optional log rows.
  const workerLines = Math.max(0, options.maxWorkers) * (options.verbose ? 2 : 1);
  const maxLines = 1 + workerLines;
  const maxWidth = Math.max(0, options.maxWidth);
  return {
    max_lines: maxLines,
    max_line_width: maxWidth,
    // The newlines a host writes between the rows count too: the bound is what
    // the consumer receives, not what the renderer chose to call content.
    max_characters: maxLines * maxWidth + Math.max(0, maxLines - 1),
  };
}

/** The characters a finished render actually costs a consumer. PURE. */
export function redskilledStatuslineCharacters(render: RedskilledStatuslineRender): number {
  return render.lines.reduce((total, line) => total + width(line), 0) + Math.max(0, render.lines.length - 1);
}

/**
 * The line for a host that did not answer — a STATED absence, never a blank one.
 *
 * A statusline that renders nothing is indistinguishable from a machine with no
 * Workers, which is the worst possible reading of "the daemon is down": the
 * operator sees calm. So the absence gets a line of its own, and every field that
 * would otherwise be a fact about the host says it is not one.
 */
export function renderRedskilledStatuslineAbsence(input: {
  readonly options?: RedskilledStatuslineOptions;
  /** The instant the consumer asked, since no daemon supplied one. */
  readonly generated_at: string;
}): RedskilledStatuslineRender {
  const options = input.options ?? REDSKILLED_STATUSLINE_DEFAULTS;
  const line = clamp(REDSKILLED_RENDER_ABSENCE, options.maxWidth);
  return {
    version: 1,
    line,
    lines: [line],
    verbose: options.verbose,
    mode: options.mode,
    project: options.project,
    project_match: "unanswered",
    detail: "host",
    degraded: true,
    // Not `false`: an answer nobody gave is the oldest answer there is, and a
    // consumer that keys freshness off this field must never read it as current.
    stale: true,
    generated_at: input.generated_at,
  };
}

function projectBody(
  detail: RedskilledStatuslineDetail,
  projects: readonly RedskilledRenderProject[],
): readonly string[] {
  if (detail === "projects") return projects.map(renderProject);
  return [];
}

/**
 * The head — the one part of the line that never degrades.
 *
 * Whatever else is dropped, "how much of this machine is in use" survives,
 * because that is the question the statusline exists to answer.
 */
function renderHead(
  payload: RedskilledRenderPayload,
  options: RedskilledStatuslineOptions,
  workers: readonly RedskilledRenderWorker[],
  match: RedskilledStatuslineProjectMatch,
  unmatched: string,
): string {
  const parts: string[] = [];
  const unmatchedProject = match !== "matched" && match !== "name-only";
  if (options.mode === "global") {
    parts.push(`host ${payload.host.worker_count}w/${payload.host.project_count}p`);
    parts.push(memoryFigure(payload, options));
  } else if (match === "matched") {
    parts.push(`${options.project} ${workers.length}w`);
    parts.push(memoryFigure(payload, options));
    if (workers.length === 0) parts.push("idle");
  } else if (match === "name-only") {
    // The Workers still count — they are running — but the line says out loud
    // that the host holds no registration, and it never says `idle`: a project
    // nothing will be born for is stopped, not resting (#2973).
    parts.push(`${options.project} ${workers.length}w`);
    parts.push(memoryFigure(payload, options));
    parts.push(UNREGISTERED_MARK);
  } else {
    // NOT `0w idle`. An unmatched directory has no Worker count to report — the
    // host may be holding a dozen for a project this one failed to name — so the
    // head states the mismatch instead of an aggregate that reads as calm.
    parts.push(unmatched);
  }
  parts.push(engineMark(payload));
  const budget = budgetMark(payload);
  if (budget != null) parts.push(budget);
  const death = deathMark(payload);
  if (death != null) parts.push(death);
  if (payload.staleness.stale) parts.push(stalenessMark(payload));
  const line = parts.join(" ");
  if (!unmatchedProject || width(line) <= options.maxWidth || (budget == null && death == null)) {
    return line;
  }

  // A composed repair is deliberately verbose. On a narrow line keep urgent
  // quota/death marks ahead of that prose so the clamp cannot turn a refusal
  // into a false all-clear. Wide lines retain the natural refusal-first order.
  return [budget, death, unmatched, engineMark(payload), payload.staleness.stale
    ? stalenessMark(payload)
    : null]
    .filter((part): part is string => part != null)
    .join(" ");
}

/**
 * Which engine answered, and whether it is the current one. PURE.
 *
 * In the head rather than the degradable tail, because "what version is
 * answering" is the first fact a skew investigation needs and the last one an
 * operator thinks to ask for — a version reachable only from a wider terminal is
 * one nobody reads. The `⇡` is appended, never substituted: a held or behind
 * daemon still states the version it is actually running, since the number a
 * report quotes has to be the one answering the read.
 */
function engineMark(payload: RedskilledRenderPayload): string {
  const engine = payload.engine;
  const version = engine?.running_version ?? payload.daemon.daemon_version;
  if (engine == null || engine.current !== false) return `v${version}`;
  return `v${version}${ENGINE_BEHIND_MARK}`;
}

/**
 * The budget posture, in the smallest honest token. PURE.
 *
 * In the HEAD rather than the degradable tail, because it is what makes an empty
 * queue and a spent quota different screens: a one-line statusline is often the
 * only surface an operator looks at, and a drained backlog and a refused one are
 * rendered identically by every count on it.
 *
 * An `open` budget prints nothing, and so does an `unknown` one. A mark for the
 * healthy case is how a mark stops being read at all — and `unknown` is a fact
 * about this daemon's polling rather than about the token, which the dashboard
 * has room to say and a head does not.
 */
function budgetMark(payload: RedskilledRenderPayload): string | null {
  const balance = payload.github_balance;
  if (balance == null) return null;
  if (balance.posture === "spent") return `${BUDGET_SPENT_MARK} quota spent`;
  if (balance.posture === "reserved") return `${BUDGET_BAND_MARK} quota band`;
  return null;
}

/**
 * What this host could not explain, in the smallest honest token. PURE.
 *
 * The class rides with the count because `†1` alone sends the operator to a lane
 * to learn the one thing they came for, and the classes differ in what they cost:
 * `oomd` is a machine to resize and `user-signal` is somebody's Ctrl-C. A proved
 * boot loop spends that space on its repetition, span and repair clue. Otherwise
 * only the newest verdict's class is named — a head has no room for a census,
 * and `deaths.count` says how many more are behind it.
 *
 * An ABSENT block prints nothing, and so does a reaping that attributed nothing:
 * `†0` would be a badge for the healthy case, which is how a mark stops being
 * read at all.
 */
function deathMark(payload: RedskilledRenderPayload): string | null {
  const deaths = payload.deaths;
  if (deaths == null || deaths.count <= 0 || deaths.latest == null) return null;
  const loop = deaths.boot_loop;
  if (loop != null) {
    const refusal = flattenPublishedLine(loop.latest_refusal);
    return `${DEATH_MARK}${deaths.count} boot-refused ×${loop.count} in ${compactLoopSpan(loop.span_ms)}` +
      (refusal == null ? "" : ` — ${refusal}`);
  }
  return `${DEATH_MARK}${deaths.count} ${deaths.latest.sender_class}`;
}

/** A loop span without zero-valued trailing units (`4m`, not `4m0s`). PURE. */
function compactLoopSpan(spanMs: number): string {
  return formatDuration(spanMs)
    .replace(/m0s$/, "m")
    .replace(/h0m$/, "h")
    .replace(/d0h$/, "d");
}

/**
 * The head for a directory this host knows no project for. PURE.
 *
 * `project unknown` appears HERE and nowhere else, and it always carries the
 * reason: the two mismatches are fixed by different actions — one wants a
 * `project.name` or a git remote, the other wants the project registered — and a
 * line that named neither would leave the operator with a word and no next step.
 */
function unmatchedHead(
  payload: RedskilledRenderPayload,
  project: string | null,
  match: RedskilledStatuslineProjectMatch,
): {
  readonly prose: string;
  readonly repair?: RepairAction | "none";
  readonly repair_reason?: string;
} {
  if (match === "unregistered") {
    return composeRepair({
      state: `project unknown — ${project} was never registered on this host`,
      repair: registrationRepair(),
    });
  }
  if (match === "orphaned") {
    return composeRepair({
      state: `project unknown — ${project} is registered on a daemon this socket does not reach`,
      repair: noRepair(
        "this socket cannot safely replace a registration owned by an unreachable daemon",
      ),
    });
  }
  if (match === "stopped") {
    const stopped = payload.stopped_projects?.find((record) => record.project_label === project);
    return composeRepair({
      state: `project unknown — ${project} was stopped${stopped == null ? "" : ` at ${clockTime(stopped.at)}`}`,
      repair: registrationRepair(),
    });
  }
  if (match === "lapsed") {
    const lapse = payload.lapsed_projects?.find((record) => record.project_label === project);
    if (lapse != null) {
      const registered = lapse.registered_at == null ? "" : ` (registered ${clockTime(lapse.registered_at)})`;
      return composeRepair({
        state: `project unknown — ${project} lapsed at ${clockTime(lapse.at)}${registered}`,
        repair: registrationRepair(),
      });
    }
    return composeRepair({
      state: `project unknown — ${project} lapsed`,
      repair: registrationRepair(),
    });
  }
  if (match === "unresolved") {
    return composeRepair({
      state: "project unknown — this directory resolved to no project",
      repair: noRepair(
        "the directory must resolve to a project before registration args can be safe",
      ),
    });
  }
  return { prose: "" };
}

/** The clock part of a daemon instant, without consulting this process's locale. PURE. */
function clockTime(instant: string): string {
  return /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(instant)?.[1] ?? instant;
}

/**
 * Observed memory over the host ceiling, or observed alone when it is lifted.
 *
 * The local mode reports its own project's share, because an operator reading a
 * quiet line wants to know what *their* repository is spending; the host figure
 * is one mode away.
 */
function memoryFigure(payload: RedskilledRenderPayload, options: RedskilledStatuslineOptions): string {
  const observed = options.mode === "global"
    ? payload.host.observed_rss_bytes
    : payload.projects
      .filter((project) => project.project_label === options.project)
      .reduce((total, project) => total + project.observed_rss_bytes, 0);
  const ceiling = payload.host.ceiling.memory_bytes;
  if (options.mode === "global" && ceiling != null && ceiling > 0) {
    return `${formatBytes(observed)}/${formatBytes(ceiling)}`;
  }
  return formatBytes(observed);
}

/** How old the answer is, in the shortest sentence that stays honest. */
function stalenessMark(payload: RedskilledRenderPayload): string {
  const age = payload.staleness.age_ms;
  return age == null ? "!unmeasured" : `!stale ${Math.round(age / 1000)}s`;
}

/**
 * One coloured, aligned Worker row. The values come from the dashboard's cell
 * composer; this density owns only colour and width.
 */
function renderWorker(
  cells: RedskilledDashboardCells,
  widths: Record<RedskilledDashboardColumn, number>,
  columns: readonly RedskilledDashboardColumn[],
  maxWidth: number,
): string {
  const parts = columns.map((column) => colourWorkerCell(column, pad(cells[column], widths[column])));
  return clamp(`${NOBG}${SOFT}${parts.join("  ")}${RESET}`, maxWidth);
}

function renderWorkerRows(
  workers: readonly RedskilledRenderWorker[],
  options: RedskilledStatuslineOptions,
  generatedAt: string,
): { readonly lines: readonly string[]; readonly degraded: boolean } {
  const rows = workers.map((worker) => workerCells(worker, options, generatedAt));
  const populated = REDSKILLED_DASHBOARD_COLUMNS.filter((column) =>
    rows.some((row) => width(row[column]) > 0));
  const columns = [...populated];
  let widths = workerWidths(rows, columns);
  while (columns.length > 1 && workerRowWidth(widths, columns) > options.maxWidth) {
    columns.pop();
    widths = workerWidths(rows, columns);
  }
  return {
    lines: rows.map((row) => renderWorker(row, widths, columns, options.maxWidth)),
    degraded: columns.length < populated.length || workerRowWidth(widths, columns) > options.maxWidth,
  };
}

function workerWidths(
  rows: readonly RedskilledDashboardCells[],
  columns: readonly RedskilledDashboardColumn[],
): Record<RedskilledDashboardColumn, number> {
  const widths = Object.fromEntries(
    REDSKILLED_DASHBOARD_COLUMNS.map((column) => [column, 0]),
  ) as Record<RedskilledDashboardColumn, number>;
  for (const row of rows) {
    for (const column of columns) widths[column] = Math.max(widths[column], width(row[column]));
  }
  return widths;
}

function workerRowWidth(
  widths: Record<RedskilledDashboardColumn, number>,
  columns: readonly RedskilledDashboardColumn[],
): number {
  return columns.reduce((total, column) => total + widths[column], 0) + Math.max(0, columns.length - 1) * 2;
}

function colourWorkerCell(column: RedskilledDashboardColumn, raw: string): string {
  if (column === "wid") return `${BOLD}${raw}${NOBOLD}`;
  if (column === "bar") {
    return raw
      .replace(/█+/g, (done) => `${BAR_DONE}${done}`)
      .replace("▶", `${BAR_CURRENT}▶`)
      .replace("✗", `${RED}✗`)
      .replace(/░+/g, (ahead) => `${BAR_AHEAD}${ahead}`) + SOFT;
  }
  const equals = raw.indexOf("=");
  if (equals > 0) return `${KEY}${raw.slice(0, equals + 1)}${VAL}${raw.slice(equals + 1)}${SOFT}`;
  return raw;
}

/**
 * One second line per Worker that has actually logged something.
 *
 * The Worker is named again rather than left to position: the lines are printed
 * under a first line whose entries may have been reordered or clamped away, and
 * an unlabelled log line would belong to whichever Worker the reader guessed.
 */
function workerLogLine(
  worker: RedskilledRenderWorker,
  options: RedskilledStatuslineOptions,
): string | null {
  const logged = flattenPublishedLine(worker.log.last_line);
  if (logged == null) return null;
  return clamp(`  ${LOG_LINE_MARK} ${workerName(worker, options.mode)}: ${logged}`, options.maxWidth);
}

/** How one Worker is named at any density: owner-qualified in `global`. PURE. */
export function workerName(worker: RedskilledRenderWorker, mode: RedskilledStatuslineMode): string {
  return mode === "global" ? `${worker.project_label}:${worker.worker_id}` : worker.worker_id;
}

function renderProject(project: RedskilledRenderProject): string {
  return `${project.project_label} ${project.worker_count}w ${formatBytes(project.observed_rss_bytes)}`;
}

function compose(head: string, body: readonly string[], separator: string): string {
  return [head, ...body].join(separator);
}
