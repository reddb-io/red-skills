/**
 * last-outcome — what an idle host has to say for itself.
 *
 * **`idle` alone is two facts wearing one word.** A drain that landed a Ticket
 * thirty seconds ago and a drain that died an hour ago both render `0w idle`, so
 * the one glance the statusline exists for cannot separate a machine at rest
 * from a machine that stopped. The daemon already recorded both endings; nothing
 * carried them the last hop to the line.
 *
 * **The daemon stores facts; this module chooses the word.** Which stage the
 * Worker was in, what it reported, and which event kind ended it are three
 * things the daemon witnesses. Turning them into `landed`, `parked` or `lost` is
 * a rendering decision, and putting it here rather than at the recording site
 * keeps the daemon out of a vocabulary it would then have to keep — and keeps
 * the whole choice in the one package that already owns every other word on the
 * line.
 *
 * **No new lane.** The marks this reads are the ones the daemon keeps for its
 * own outcome rate, replayed on restart from `redskilled.log.toonl`. A restarted
 * daemon's replay carries the project and the kind but not the Worker's own
 * account of its work, so a recovered mark renders a coarser word and no issue
 * number — less, honestly, rather than the same amount confidently.
 *
 * PURE.
 */
import { formatDuration } from "./format.js";
import type { RedskilledRenderLastOutcome } from "./payload.js";

/**
 * The words an idle line may end with, each paired with what earns it.
 *
 * Ordered as the resolver tries them: the first row whose condition holds wins,
 * so a budget kill is never re-read as a clean finish just because the Worker
 * had reached its last stage.
 *
 * Declared as a table rather than a `switch` so the set is enumerable by a test
 * and so a new ending is a row, not a branch. `unknown` is deliberately absent:
 * a mark matching nothing renders no cell, because the plain `idle` an operator
 * already understands beats a word invented to fill the slot.
 */
export const REDSKILLED_LAST_OUTCOME_WORDS = [
  {
    word: "killed",
    why: "the host ended this Worker on its resource budget, whatever it was doing",
    matches: (mark: RedskilledRenderLastOutcome): boolean => mark.kind === "worker-budget-kill",
  },
  {
    word: "parked",
    why: "the Worker's last stage reported `ok: false` — it stopped on a refusal, not on a finish",
    matches: (mark: RedskilledRenderLastOutcome): boolean => (mark.phase ?? "").endsWith("!"),
  },
  {
    word: "landed",
    why: "the Worker reported its work done from the stage that reaches the trunk",
    matches: (mark: RedskilledRenderLastOutcome): boolean =>
      mark.birth_outcome === "work-reported" && LANDING_STAGES.has((mark.phase ?? "").toLowerCase()),
  },
  {
    word: "done",
    why: "the Worker reported its work done from an earlier stage; what reached the trunk is the trunk's to say",
    matches: (mark: RedskilledRenderLastOutcome): boolean => mark.birth_outcome === "work-reported",
  },
  {
    word: "no-work",
    why: "the Worker booted, read the queue, found nothing eligible and said so",
    matches: (mark: RedskilledRenderLastOutcome): boolean => mark.birth_outcome === "no-eligible-work",
  },
  {
    word: "lost",
    why: "the Worker ended without reporting anything — a crash, a signal, a non-zero exit",
    matches: (mark: RedskilledRenderLastOutcome): boolean => mark.birth_outcome === "unreported",
  },
] as const;

/**
 * The stages from which "I am done" also means "it reached the trunk".
 *
 * `land` is the ticket loop's last stage and `merging` is its macro phase; a
 * Worker reporting done from `implement` finished something else. The
 * distinction is why `done` exists beside `landed` rather than every clean exit
 * claiming a landing the daemon never witnessed.
 */
const LANDING_STAGES = new Set(["land", "merging", "merge", "cascade", "done"]);

/**
 * The word for one ending; `null` when no declared row claims it. PURE.
 */
export function lastOutcomeWord(mark: RedskilledRenderLastOutcome): string | null {
  return REDSKILLED_LAST_OUTCOME_WORDS.find((row) => row.matches(mark))?.word ?? null;
}

/**
 * The idle cell: `idle·landed #4175 3m`, or plain `idle`. PURE.
 *
 * The age is the distance from the ending to the payload's own instant, never a
 * clock this module reads — a render that dated itself would put a second
 * authority on "how long ago" beside the one every other cell answers to.
 *
 * Four things each degrade one piece and keep the rest: a host that has never
 * run a Worker renders `idle`; an ending in another project renders `idle`,
 * because one repository's last landing on a shared machine is not this
 * repository's news; a replayed mark with no work item renders the word without
 * a number; and an unreadable instant renders the word without an age.
 */
export function idleCell(
  mark: RedskilledRenderLastOutcome | null | undefined,
  project: string | null,
  generatedAt: string,
): string {
  if (mark == null) return "idle";
  if (project != null && mark.project_label != null && mark.project_label !== project) return "idle";
  const word = lastOutcomeWord(mark);
  if (word == null) return "idle";
  const ended = Date.parse(mark.ts);
  const now = Date.parse(generatedAt);
  const age = Number.isFinite(ended) && Number.isFinite(now)
    ? compactAge(Math.max(0, now - ended))
    : null;
  const issue = mark.issue == null || mark.issue === "" ? null : `#${mark.issue.replace(/^#/, "")}`;
  return [`idle·${word}`, issue, age].filter((part): part is string => part != null).join(" ");
}

/** An age without zero-valued trailing units (`3m`, not `3m0s`). PURE. */
function compactAge(ageMs: number): string {
  return formatDuration(ageMs)
    .replace(/m0s$/, "m")
    .replace(/h0m$/, "h")
    .replace(/d0h$/, "d");
}
