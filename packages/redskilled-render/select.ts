/**
 * select — which Workers a surface is about, and how much of them survives.
 *
 * **The degradation ladder is layout, so it lives here** (ADR 0132 decision 4).
 * It used to sit inside the statusline renderer, where it was reachable by one
 * density and invisible to the other three; a dashboard that dropped rows without
 * the ladder's vocabulary would degrade differently from the line above it, which
 * is the two-authorities failure the whole module exists to end.
 *
 * **A selection is never a second answer.** Every density asks these functions
 * rather than filtering the Worker set itself, so a line and a table standing in
 * the same directory list the same Workers by construction.
 *
 * PURE: payload and taste in, a subset out.
 */
import type {
  RedskilledRenderPayload,
  RedskilledRenderProject,
  RedskilledRenderWorker,
  RedskilledStatuslineMode,
} from "./payload.js";

/** How much detail survived the width and count budgets. */
export type RedskilledStatuslineDetail = "workers" | "projects" | "host";

/**
 * Whether the calling directory's project is one this host knows.
 *
 * Several states rather than a boolean, because the failures need different
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
  /** The daemon recorded when and why this project's registration lapsed. */
  | "lapsed"
  | "unregistered"
  | "unresolved"
  /** No daemon answered, so whether this host knows the project is unknowable. */
  | "unanswered";

/**
 * The Workers a surface is about.
 *
 * The default mode keeps the session inside its own repository; a session that
 * declared no project has nothing to filter on, and rather than guess it shows
 * none — the head still carries the host total, so the render stays truthful.
 */
export function selectRenderWorkers(
  payload: RedskilledRenderPayload,
  taste: { readonly mode: RedskilledStatuslineMode; readonly project: string | null },
): readonly RedskilledRenderWorker[] {
  if (taste.mode === "global") return payload.workers;
  if (taste.project == null) return [];
  return payload.workers.filter((worker) => worker.project_label === taste.project);
}

/** The projects a surface is about — the same rule, one level up. PURE. */
export function selectRenderProjects(
  payload: RedskilledRenderPayload,
  taste: { readonly mode: RedskilledStatuslineMode; readonly project: string | null },
): readonly RedskilledRenderProject[] {
  if (taste.mode === "global") return payload.projects;
  return payload.projects.filter((project) => project.project_label === taste.project);
}

/**
 * Does this host know the project the caller is standing in? PURE.
 *
 * A daemon older than `known_projects` cannot say, and the answer then is
 * `matched`, never a guess at a mismatch: this decides whether an operator is
 * told their project is unregistered, and inventing that from a missing field
 * would put a false accusation on every line a skewed daemon serves.
 */
export function resolveStatuslineProjectMatch(
  payload: RedskilledRenderPayload,
  project: string | null,
): RedskilledStatuslineProjectMatch {
  if (project == null) return "unresolved";
  if (payload.known_projects == null) return "matched";
  if (!payload.known_projects.includes(project)) return "unregistered";
  // Known, and possibly known only by NAME. A daemon too old to state its
  // registrations cannot say which, and the answer then is `matched` for the same
  // reason it is above: a lapse invented from a missing field would put a false
  // accusation on every line a skewed daemon serves.
  if (payload.registered_projects == null) return "matched";
  if (payload.registered_projects.includes(project)) return "matched";
  if (payload.lapsed_projects?.some((lapse) => lapse.project_label === project) === true) {
    return "lapsed";
  }
  return "name-only";
}

/**
 * The detail levels a render may use, richest first. PURE.
 *
 * A level whose count budget is already blown is never attempted: the budgets
 * are the operator's declared taste, and honouring them only when the line
 * happens to be long would make the setting mean nothing on a wide terminal.
 */
export function detailLadder(input: {
  readonly mode: RedskilledStatuslineMode;
  readonly maxWorkers: number;
  readonly maxProjects: number;
  readonly workers: readonly RedskilledRenderWorker[];
  readonly projects: readonly RedskilledRenderProject[];
}): readonly RedskilledStatuslineDetail[] {
  const ladder: RedskilledStatuslineDetail[] = [];
  if (input.workers.length > 0 && input.workers.length <= input.maxWorkers) ladder.push("workers");
  // The local mode holds one project by construction, so a per-project line
  // would repeat the head verbatim. Only `global` has an aggregate worth a step.
  if (input.mode === "global" && input.projects.length > 0 && input.projects.length <= input.maxProjects) {
    ladder.push("projects");
  }
  ladder.push("host");
  return ladder;
}
