/**
 * statusline-render — the finished line, and nothing behind it.
 *
 * **The string is a pure function of the payload.** That purity is the whole
 * mitigation for having two surfaces at all (ADR 0130 rule 10): a renderer that
 * could reach for one extra fact — a directory listing, a clock, an environment
 * variable — would be a second authority on a question the payload already
 * answers, and the two surfaces would eventually describe different machines.
 * Everything this function needs is an argument, so a test can prove the string
 * the daemon serves is the string this function computes from the payload the
 * daemon serves alongside it.
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
import type {
  RedskilledStatuslinePayload,
  RedskilledStatuslineProject,
  RedskilledStatuslineWorker,
} from "./statusline-payload.js";

/** Which Workers the line is about. */
export type RedskilledStatuslineMode = "local" | "global";

/** How much detail survived the width and count budgets. */
export type RedskilledStatuslineDetail = "workers" | "projects" | "host";

/**
 * Whether the calling directory's project is one this host knows.
 *
 * Three states rather than a boolean, because the two failures need different
 * sentences: a directory that resolved to no project at all has nothing to look
 * up, while one that resolved to `acme/widgets` and found no such project on the
 * host has a name to put in front of the operator. Collapsing either into
 * `matched` is how "the host holds three of your Workers" renders as `0w`.
 */
export type RedskilledStatuslineProjectMatch =
  | "matched"
  /**
   * The host knows this label, and holds no registration for it.
   *
   * A name is not a state (#2973). A project whose registration lapsed while a
   * Worker of its own is still finishing is still *known* — the label is on the
   * Worker — but nothing will be born for it again, so rendering it as a matched
   * project is rendering a stopped drain as a healthy one.
   */
  | "name-only"
  | "unregistered"
  | "unresolved"
  /** No daemon answered, so whether this host knows the project is unknowable. */
  | "unanswered";

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
 * which is the failure this whole tool exists to remove.
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
  payload: RedskilledStatuslinePayload,
  options: RedskilledStatuslineOptions = REDSKILLED_STATUSLINE_DEFAULTS,
): RedskilledStatuslineRender {
  const match = resolveProjectMatch(payload, options);
  const workers = selectWorkers(payload, options);
  const projects = selectProjects(payload, options);
  const head = renderHead(payload, options, workers, match);

  const ladder = detailLadder(options, workers, projects);
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
  const line = clamp(REDSKILLED_STATUSLINE_ABSENCE, options.maxWidth);
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

/**
 * The mark a known-by-name project carries, and the reason it carries one.
 *
 * `!` for the same reason the staleness mark has one: it is a state the operator
 * has to act on, not a detail, and it must survive being read at a glance next to
 * a Worker count that looks perfectly healthy. One word, because the head is the
 * part of the line that never degrades — a sentence here would push the Workers
 * off a narrow terminal to say something `project_status` says in full.
 */
export const UNREGISTERED_MARK = "!unregistered";

/** The one sentence an unreachable host renders as. */
export const REDSKILLED_STATUSLINE_ABSENCE = "redskilled unreachable — Worker state unknown";

/**
 * The detail levels this render may use, richest first.
 *
 * A level whose count budget is already blown is never attempted: the budgets
 * are the operator's declared taste, and honouring them only when the line
 * happens to be long would make the setting mean nothing on a wide terminal.
 */
function detailLadder(
  options: RedskilledStatuslineOptions,
  workers: readonly RedskilledStatuslineWorker[],
  projects: readonly RedskilledStatuslineProject[],
): readonly RedskilledStatuslineDetail[] {
  const ladder: RedskilledStatuslineDetail[] = [];
  if (workers.length > 0 && workers.length <= options.maxWorkers) ladder.push("workers");
  // The local mode holds one project by construction, so a per-project line
  // would repeat the head verbatim. Only `global` has an aggregate worth a step.
  if (options.mode === "global" && projects.length > 0 && projects.length <= options.maxProjects) {
    ladder.push("projects");
  }
  ladder.push("host");
  return ladder;
}

function body(
  detail: RedskilledStatuslineDetail,
  options: RedskilledStatuslineOptions,
  workers: readonly RedskilledStatuslineWorker[],
  projects: readonly RedskilledStatuslineProject[],
): readonly string[] {
  if (detail === "workers") return workers.map((worker) => renderWorker(worker, options));
  if (detail === "projects") return projects.map(renderProject);
  return [];
}

/**
 * The Workers this line is about.
 *
 * The default mode keeps the session inside its own repository; a session that
 * declared no project has nothing to filter on, and rather than guess it shows
 * none — the head still carries the host total, so the line stays truthful.
 */
function selectWorkers(
  payload: RedskilledStatuslinePayload,
  options: RedskilledStatuslineOptions,
): readonly RedskilledStatuslineWorker[] {
  if (options.mode === "global") return payload.workers;
  if (options.project == null) return [];
  return payload.workers.filter((worker) => worker.project_label === options.project);
}

function selectProjects(
  payload: RedskilledStatuslinePayload,
  options: RedskilledStatuslineOptions,
): readonly RedskilledStatuslineProject[] {
  if (options.mode === "global") return payload.projects;
  return payload.projects.filter((project) => project.project_label === options.project);
}

/**
 * Does this host know the project the caller is standing in? PURE.
 *
 * A daemon older than `known_projects` cannot say, and the answer then is
 * `matched`, never a guess at a mismatch: this decides whether an operator is
 * told their project is unregistered, and inventing that from a missing field
 * would put a false accusation on every line a skewed daemon serves.
 */
function resolveProjectMatch(
  payload: RedskilledStatuslinePayload,
  options: RedskilledStatuslineOptions,
): RedskilledStatuslineProjectMatch {
  if (options.project == null) return "unresolved";
  if (payload.known_projects == null) return "matched";
  if (!payload.known_projects.includes(options.project)) return "unregistered";
  // Known, and possibly known only by NAME. A daemon too old to state its
  // registrations cannot say which, and the answer then is `matched` for the same
  // reason it is above: a lapse invented from a missing field would put a false
  // accusation on every line a skewed daemon serves.
  if (payload.registered_projects == null) return "matched";
  return payload.registered_projects.includes(options.project) ? "matched" : "name-only";
}

/**
 * The head — the one part of the line that never degrades.
 *
 * Whatever else is dropped, "how much of this machine is in use" survives,
 * because that is the question the statusline exists to answer.
 */
function renderHead(
  payload: RedskilledStatuslinePayload,
  options: RedskilledStatuslineOptions,
  workers: readonly RedskilledStatuslineWorker[],
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
    parts.push(unmatchedHead(options.project, match));
  }
  if (payload.staleness.stale) parts.push(stalenessMark(payload));
  return parts.join(" ");
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
function memoryFigure(payload: RedskilledStatuslinePayload, options: RedskilledStatuslineOptions): string {
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
function stalenessMark(payload: RedskilledStatuslinePayload): string {
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
function renderWorker(worker: RedskilledStatuslineWorker, options: RedskilledStatuslineOptions): string {
  const name = workerName(worker, options);
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
  workers: readonly RedskilledStatuslineWorker[],
  options: RedskilledStatuslineOptions,
): readonly string[] {
  const lines: string[] = [];
  for (const worker of workers) {
    const logged = flatten(worker.log.last_line);
    if (logged == null) continue;
    lines.push(clamp(`  ${LOG_LINE_MARK} ${workerName(worker, options)}: ${logged}`, options.maxWidth));
  }
  return lines;
}

/** The mark that says "this line belongs to the entry above it". */
const LOG_LINE_MARK = "↳";

/**
 * A published line reduced to something that fits on one row. PURE.
 *
 * Whitespace — a newline included — is collapsed rather than escaped, and control
 * characters are dropped: the daemon stored the string a Worker published
 * verbatim, and this is the last moment before it becomes a terminal's line.
 * Returns `null` when nothing survives, which is the same absence as no publish.
 */
function flatten(line: string | null): string | null {
  if (line == null) return null;
  const collapsed = line
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed === "" ? null : collapsed;
}

/** How one Worker is named on this line: owner-qualified in `global`. PURE. */
function workerName(worker: RedskilledStatuslineWorker, options: RedskilledStatuslineOptions): string {
  return options.mode === "global" ? `${worker.project_label}:${worker.worker_id}` : worker.worker_id;
}

function renderProject(project: RedskilledStatuslineProject): string {
  return `${project.project_label} ${project.worker_count}w ${formatBytes(project.observed_rss_bytes)}`;
}

function compose(head: string, body: readonly string[], separator: string): string {
  return [head, ...body].join(separator);
}

/** The visible width. One character is one column here — the line carries no ANSI. */
function width(line: string): number {
  return [...line].length;
}

function clamp(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const chars = [...line];
  if (chars.length <= maxWidth) return line;
  if (maxWidth === 1) return "…";
  return `${chars.slice(0, maxWidth - 1).join("")}…`;
}

/**
 * Bytes at statusline resolution: three significant characters, never more.
 *
 * Exactness is the payload's job. A line that read `1.234567G` would spend the
 * width it does not have on precision nobody acts on.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "K", "M", "G", "T"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rendered = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${rendered}${units[unit]}`;
}
