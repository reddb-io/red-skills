// registration-query — the one string a registration hands the host as its work.
//
// ADR 0130 Amendment 4 splits the lane in two: the project REGISTERS and the
// daemon POLLS. The seam between them is a single opaque string, and the daemon
// hands that string to the tracker verbatim — it "carries a selector, never
// reads one" (rule 3). Which means the string has to be a TRACKER QUERY. A
// registration that carried the project's own JSON selector shape was carrying
// something only the project can read, so the daemon dutifully asked GitHub to
// search for `{}` and got an answer about nothing (#2974).
//
// **Every facet this query can express, it expresses; the rest the Worker
// enforces.** `spec` and `issues` name graph edges and specific numbers, which
// issue search cannot filter on — so a query narrowed by the expressible facets
// counts an UPPER BOUND for those two, and the demand loop's target still caps
// how wide the project goes. The bound is stated here rather than silently
// assumed, because an over-count births a Worker that finds nothing and exits,
// while an under-count would strand real work — and only one of those is safe.
//
// PURE — string in, string out, no tracker, no filesystem, no process.

import { LABEL_READY, TAG_LABEL_PREFIX } from "./triage-labels.js";

/** The facets a registration may narrow its queue with. Mirrors `WorkSelector`. */
export interface RegistrationQuerySelector {
  spec?: number;
  lane?: string;
  label?: string;
  issues?: number[];
  tags?: string[];
  user?: string;
}

export interface RegistrationQueryInput {
  /** `owner/name` — the repository whose tracker holds this project's queue. */
  readonly repo: string;
  readonly selector?: RegistrationQuerySelector | undefined;
  /** The label that defines "queued"; the executable lane's own by default. */
  readonly readyLabel?: string;
}

/** The repository list request equivalent to a registration query. */
export interface RegistrationPollPlan {
  readonly owner: string;
  readonly repo: string;
  readonly labels: readonly string[];
  readonly creator?: string;
}

/**
 * Build the tracker query for one registration.
 *
 * The base is the executable queue itself — open issues in this repository
 * carrying the ready label — because that is what "this project's work" means to
 * every other surface in the repo, and a registration that meant something else
 * would give the host a depth no operator could reconcile with the statusline.
 *
 * A facet the query cannot express is left out rather than faked: a `lane`
 * becomes `label:"lane:x"`, a `tags` list becomes one `label:"tag:v"` per tag
 * (AND, which is the selector's own meaning), a `user` becomes `author:`, and
 * `spec`/`issues` are carried by the argv to the Worker instead.
 */
export function buildRegistrationQuery(input: RegistrationQueryInput): string {
  const repo = requireRepo(input.repo).join("/");
  const selector = input.selector ?? {};
  const terms = [`repo:${repo}`, "is:issue", "is:open", label(input.readyLabel ?? LABEL_READY)];
  if (selector.lane != null && selector.lane !== "") terms.push(label(`lane:${selector.lane}`));
  if (selector.label != null && selector.label !== "") terms.push(label(selector.label));
  for (const tag of selector.tags ?? []) {
    if (tag !== "") terms.push(label(`${TAG_LABEL_PREFIX}${tag}`));
  }
  if (selector.user != null && selector.user !== "" && selector.user !== "@me") {
    terms.push(`author:${selector.user}`);
  }
  return terms.join(" ");
}

/**
 * Build the typed REST list description beside the opaque tracker query. PURE.
 *
 * The project owns this translation because it understands selector facets. The
 * daemon only carries the resulting route parameters to the transport, so moving
 * the poll to an ETag-capable endpoint does not teach the host to parse selectors.
 */
export function buildRegistrationPollPlan(input: RegistrationQueryInput): RegistrationPollPlan {
  const [owner, repo] = requireRepo(input.repo);
  const selector = input.selector ?? {};
  const labels = [input.readyLabel ?? LABEL_READY];
  if (selector.lane != null && selector.lane !== "") labels.push(`lane:${selector.lane}`);
  if (selector.label != null && selector.label !== "") labels.push(selector.label);
  for (const tag of selector.tags ?? []) {
    if (tag !== "") labels.push(`${TAG_LABEL_PREFIX}${tag}`);
  }
  const creator = selector.user != null && selector.user !== "" && selector.user !== "@me"
    ? selector.user
    : undefined;
  return { owner, repo, labels, ...(creator === undefined ? {} : { creator }) };
}

/**
 * Which facets the query left for the Worker to enforce — named, never hidden.
 *
 * The caller reports these to the operator who asked, so "the host says 4 and my
 * Spec has 2 Tickets left" is an answer rather than a contradiction.
 */
export function registrationQueryUnexpressedFacets(
  selector: RegistrationQuerySelector | undefined,
): readonly string[] {
  const unexpressed: string[] = [];
  if (selector?.spec != null) unexpressed.push("spec");
  if (selector?.issues != null && selector.issues.length > 0) unexpressed.push("issues");
  return unexpressed;
}

function label(value: string): string {
  return `label:${JSON.stringify(value)}`;
}

function requireRepo(value: string): readonly [string, string] {
  const parts = value.trim().split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new Error(
      "a registration needs the repository its queue lives in: the daemon polls the string it is handed and " +
        "cannot work out which tracker a checkout belongs to",
    );
  }
  return [parts[0]!, parts[1]!];
}
