/**
 * The registration this container hands the daemon, so the daemon's demand
 * loop becomes this lane's queue loop.
 *
 * **The project authors the work; the daemon carries it.** ADR 0130 Amendment 4
 * splits the lane exactly there, and rule 3 forbids the daemon from learning
 * what an Issue, a label or a ready lane is. So the selector, the poll plan, the
 * birth argv and the Worker's prompt are composed HERE — the container is the
 * side that knows which repository it was pointed at and which label defines
 * "queued" — and are opaque strings from the socket onward.
 *
 * This mirrors `apps/plugin-dev/src/core/drain-registration.ts`, which composes
 * the same record for a human's checkout. The two cannot be one module: that one
 * asks a checkout's git remote and `.red/config.yaml` what this project is,
 * while the container is told by its environment and ships no repository source
 * at all. `apps/plugin-dev/tests/worker-container-lane.test.ts` pins the halves
 * that MUST agree — the Worker prompt above all — so the mirror cannot drift.
 *
 * PURE — strings in, one record out; no daemon, no filesystem, no process.
 */

/** The label that defines "queued" when the operator names none. */
export const DEFAULT_READY_LABEL = "ready-for-agent";

/** The label that parks an issue out of agent reach; counted, never claimed. */
export const HUMAN_LABEL = "ready-for-human";

/**
 * What a Worker born for this project is told to do.
 *
 * Identical to `DRAIN_WORKER_PROMPT` in `drain-registration.ts`, and pinned
 * against it by a ratchet: one product means one division of labour, and a
 * container whose Workers were briefed differently would be a second contract
 * nobody wrote down. The daemon writes `{{work_item}}` in at birth (#4099).
 */
export const CONTAINER_WORKER_PROMPT =
  "Implement issue #{{work_item}} in this workspace. The Ticket is already claimed for you, and " +
  "the daemon runs the gate, publishes your commits and lands the pull request after you finish — " +
  "so never touch GitHub yourself: no label moves, no claim or status comments, no PR. Your whole " +
  "job is the change and its commits, right here. " +
  "You are already standing in your own dedicated worktree on the Ticket's base branch: work and " +
  "commit right here, and never create another worktree — the repository's worktree lanes govern " +
  "interactive sessions, not Workers. " +
  "If your change touches apps/ or packages/, also write a .changeset/<slug>.md entry naming each " +
  "touched package by its package.json name with a patch bump, and commit it with the change. " +
  "When the change is committed, say <promise>DONE</promise>. If the work is genuinely blocked, " +
  "say what blocks it and <promise>BLOCKED</promise>.";

function splitRepo(repo) {
  const parts = String(repo ?? "").trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `a registration needs the repository its queue lives in, as "owner/name": got ${JSON.stringify(repo)}`,
    );
  }
  return parts;
}

function labelTerm(value) {
  return `label:${JSON.stringify(value)}`;
}

/**
 * Every label this drain narrows its queue with, ready label first. PURE.
 *
 * A lane is expressed as the `lane:<x>` label it already is, so an operator who
 * wants a container to drain one lane says so once and both the opaque tracker
 * query and the typed REST plan narrow the same way.
 */
export function registrationLabels({ readyLabel, lane, label } = {}) {
  const labels = [readyLabel || DEFAULT_READY_LABEL];
  if (lane) labels.push(`lane:${lane}`);
  if (label) labels.push(label);
  return labels;
}

/** The opaque tracker query the daemon hands its transport verbatim. PURE. */
export function buildRegistrationQuery(input) {
  const [owner, name] = splitRepo(input.repo);
  return [`repo:${owner}/${name}`, "is:issue", "is:open", ...registrationLabels(input).map(labelTerm)].join(" ");
}

/** The typed REST equivalent of that query, so the poll can revalidate. PURE. */
export function buildRegistrationPollPlan(input) {
  const [owner, repo] = splitRepo(input.repo);
  return {
    owner,
    repo,
    labels: registrationLabels(input),
    // Both names cross the boundary; the daemon compares them to tracker data
    // and never learns what makes either one a workflow queue.
    counter_labels: { ready: input.readyLabel || DEFAULT_READY_LABEL, human: HUMAN_LABEL },
  };
}

/**
 * The whole registration a container drain carries. PURE.
 *
 * `argv` names a command that exists, because the daemon probes it before it
 * accepts the record (#4103) and refuses a launch that cannot answer
 * `--version`. `trunk` is required in practice rather than in the type: the
 * daemon states a Ticket handoff only when every fact is present, and a
 * registration without a base births Workers nobody ever briefed.
 */
export function buildContainerRegistration(input) {
  const target = Number.isInteger(input.target) && input.target >= 0 ? input.target : 1;
  return {
    selector: buildRegistrationQuery(input),
    queue_poll: buildRegistrationPollPlan(input),
    argv: [...input.argv],
    workspace_path: input.workspacePath,
    trunk: { remote: "origin", branch: input.trunkBranch || "main" },
    prompt: CONTAINER_WORKER_PROMPT,
    ...(input.validationCommands?.length ? { validation_commands: [...input.validationCommands] } : {}),
    target,
  };
}
