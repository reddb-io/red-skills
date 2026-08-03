/**
 * line — the statusline density: one row, and nothing behind it.
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
 * **A crowded machine degrades to an aggregate rather than overflowing.** The
 * statusline answers "who is using this machine and how much"; it is not the
 * dashboard. When the Workers do not fit, the line drops to one entry per
 * project, and when the projects do not fit it drops to the host total — losing
 * detail on purpose, never losing the line.
 */
import { clamp, flattenPublishedLine, formatBytes, width } from "./format.js";
import {
  BUDGET_BAND_MARK,
  BUDGET_SPENT_MARK,
  DEATH_MARK,
  ENGINE_BEHIND_MARK,
  LAPSED_MARK,
  LOG_LINE_MARK,
  REDSKILLED_RENDER_ABSENCE,
  UNREGISTERED_MARK,
} from "./marks.js";
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
 * The finished statusline. PURE — payload and options in, one line out.
 *
 * The line is built at the richest detail the budgets allow and then re-built
 * one step poorer for as long as it does not fit. Rebuilding rather than
 * trimming is deliberate: a trimmed line ends mid-fact, and a half-printed
 * memory figure is worse than an honest aggregate.
 */
export function renderRedskilledStatusline(
  payload: RedskilledRenderPayload,
  options: RedskilledStatuslineOptions = REDSKILLED_STATUSLINE_DEFAULTS,
): RedskilledStatuslineRender {
  const match = resolveStatuslineProjectMatch(payload, options.project);
  const workers = selectRenderWorkers(payload, options);
  const projects = selectRenderProjects(payload, options);
  const head = renderHead(payload, options, workers, match);

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
    const line = compose(head, body(detail, options, workers, projects), options.separator);
    chosen = { detail, line };
    if (width(line) <= options.maxWidth) break;
  }
  // Even the host aggregate can outgrow a very narrow line; a clamp is the last
  // resort and never the normal path, so it keeps the ellipsis visible.
  const line = clamp(chosen.line, options.maxWidth);
  // Second lines belong to Worker entries, so they exist only while the line is
  // still listing Workers: annotating an aggregate would attach a Worker's log to
  // a row that names a project.
  const extra = options.verbose && chosen.detail === "workers"
    ? workerLogLines(workers, options)
    : [];
  // Degradation is measured against the richest detail this payload COULD have
  // shown, not against the richest one the budgets allowed: a line that dropped
  // the Workers because `max_workers` said so is degraded in the only sense a
  // reader cares about — there is more to see than is on the line.
  const richest: RedskilledStatuslineDetail = workers.length > 0 ? "workers" : "host";

  return {
    version: 1,
    line,
    lines: [line, ...extra],
    verbose: options.verbose,
    mode: options.mode,
    project: options.project,
    project_match: match,
    detail: chosen.detail,
    degraded: chosen.detail !== richest || line !== chosen.line,
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
  /** The head, plus at most one second line per listed Worker. */
  readonly max_lines: number;
  readonly max_line_width: number;
  /** Every rendered line together, separators included. */
  readonly max_characters: number;
}

/** What {@link renderRedskilledStatusline} may at most produce. PURE. */
export function redskilledStatuslineBound(
  options: RedskilledStatuslineOptions = REDSKILLED_STATUSLINE_DEFAULTS,
): RedskilledStatuslineBound {
  // A second line exists only while the line still lists Workers, and the line
  // lists Workers only while there are no more of them than the budget allows —
  // so the Worker budget bounds the row count, whatever the host holds.
  const maxLines = options.verbose ? 1 + Math.max(0, options.maxWorkers) : 1;
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

function body(
  detail: RedskilledStatuslineDetail,
  options: RedskilledStatuslineOptions,
  workers: readonly RedskilledRenderWorker[],
  projects: readonly RedskilledRenderProject[],
): readonly string[] {
  if (detail === "workers") return workers.map((worker) => renderWorker(worker, options));
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
): string {
  const parts: string[] = [];
  if (options.mode === "global") {
    parts.push(`host ${payload.host.worker_count}w/${payload.host.project_count}p`);
    parts.push(memoryFigure(payload, options));
  } else if (match === "matched") {
    parts.push(`${options.project} ${workers.length}w`);
    parts.push(memoryFigure(payload, options));
    if (workers.length === 0) parts.push("idle");
  } else if (match === "name-only" || match === "lapsed") {
    // The Workers still count — they are running — but the line says out loud
    // that the host holds no registration, and it never says `idle`: a project
    // nothing will be born for is stopped, not resting (#2973).
    parts.push(`${options.project} ${workers.length}w`);
    parts.push(memoryFigure(payload, options));
    parts.push(match === "lapsed" ? LAPSED_MARK : UNREGISTERED_MARK);
  } else {
    // NOT `0w idle`. An unmatched directory has no Worker count to report — the
    // host may be holding a dozen for a project this one failed to name — so the
    // head states the mismatch instead of an aggregate that reads as calm.
    parts.push(unmatchedHead(options.project, match));
  }
  parts.push(engineMark(payload));
  const budget = budgetMark(payload);
  if (budget != null) parts.push(budget);
  const death = deathMark(payload);
  if (death != null) parts.push(death);
  if (payload.staleness.stale) parts.push(stalenessMark(payload));
  return parts.join(" ");
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
 * `oomd` is a machine to resize and `user-signal` is somebody's Ctrl-C. Only the
 * newest verdict's class is named — a head has no room for a census, and
 * `deaths.count` says how many more are behind it.
 *
 * An ABSENT block prints nothing, and so does a reaping that attributed nothing:
 * `†0` would be a badge for the healthy case, which is how a mark stops being
 * read at all.
 */
function deathMark(payload: RedskilledRenderPayload): string | null {
  const deaths = payload.deaths;
  if (deaths == null || deaths.count <= 0 || deaths.latest == null) return null;
  return `${DEATH_MARK}${deaths.count} ${deaths.latest.sender_class}`;
}

/**
 * The head for a directory this host knows no project for. PURE.
 *
 * `project unknown` appears HERE and nowhere else, and it always carries the
 * reason: the two mismatches are fixed by different actions — one wants a
 * `project.name` or a git remote, the other wants the project registered — and a
 * line that named neither would leave the operator with a word and no next step.
 */
function unmatchedHead(project: string | null, match: RedskilledStatuslineProjectMatch): string {
  return match === "unregistered"
    ? `project unknown — ${project} is not registered on this host`
    : "project unknown — this directory resolved to no project";
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
 * One Worker. In `global`, the owning project rides on the entry itself.
 *
 * A separate "these belong to acme/widgets" grouping was rejected: the line has
 * no vertical dimension to group in, so the owner has to travel with the Worker
 * or it is not shown at all.
 */
function renderWorker(worker: RedskilledRenderWorker, options: RedskilledStatuslineOptions): string {
  const name = workerName(worker, options.mode);
  const used = worker.vitals.rss_bytes;
  // An unmeasured Worker says so. A zero here would read as an idle Worker, and
  // "nothing measured it" and "it is using nothing" are opposite facts.
  const usage = used == null
    ? "?"
    : worker.budget.bytes == null
      ? formatBytes(used)
      : `${formatBytes(used)}/${formatBytes(worker.budget.bytes)}`;
  return `${name} ${usage}`;
}

/**
 * One second line per Worker that has actually logged something.
 *
 * The Worker is named again rather than left to position: the lines are printed
 * under a first line whose entries may have been reordered or clamped away, and
 * an unlabelled log line would belong to whichever Worker the reader guessed.
 */
function workerLogLines(
  workers: readonly RedskilledRenderWorker[],
  options: RedskilledStatuslineOptions,
): readonly string[] {
  const lines: string[] = [];
  for (const worker of workers) {
    const logged = flattenPublishedLine(worker.log.last_line);
    if (logged == null) continue;
    lines.push(clamp(`  ${LOG_LINE_MARK} ${workerName(worker, options.mode)}: ${logged}`, options.maxWidth));
  }
  return lines;
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
