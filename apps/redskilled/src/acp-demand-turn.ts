/**
 * acp-demand-turn — the daemon's own turn, for a Worker nobody is watching.
 *
 * **A birth nobody speaks to does nothing.** The demand loop births a process
 * for each unit of queue demand and then never prompts it, while every client
 * turn goes through admission → session → prompt (`acp-worker-admission.ts`,
 * `acp-worker-lifecycle.ts`). That gap is the whole reason a registered,
 * draining project produced Workers and no work (Spec #4097, #4100).
 *
 * This runs the same admission and the same turn with **no client on the other
 * end**: its own session map, its own synthetic session id, and a sink that
 * records lifecycle where a client would have been notified. It deliberately
 * does not borrow a connection's session map — an unattended turn that lived
 * inside a client's would die when that client disconnected, which is the one
 * property a drain must not have (#3885).
 *
 * The daemon still reads nothing: the prompt is a project-authored string with
 * the daemon's own facts expanded into it, exactly as the argv already was.
 */
import type {
  AgentConnection,
  NewSessionRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { randomBytes } from "node:crypto";

import { parkGateBlockedTurn } from "./demand-park.js";
import { admitNativeAcpWorker } from "./acp-worker-admission.js";
import { ACP_AGENT_IDS, type AcpAgentId } from "@reddb-io/protocol-acp";
import { expandLaunchTemplate } from "./launch-template.js";
import {
  cleanupWorkflowWorker,
  requestWorkflowTurn,
  workflowOutcome,
  type ActiveWorkflowWorker,
} from "./acp-worker-lifecycle.js";
import type { AcpSessionJournal } from "./acp-session-journal.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { RedskilledPaths } from "./paths.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import type { LaunchedWorker, RedskilledWorkerSpec } from "./worker-launch.js";

/** What one unattended turn needs to exist. The daemon's own facts, no client's. */
export interface DemandTurnDeps {
  readonly paths: RedskilledPaths;
  readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
  readonly hostState: () => { readonly workers: readonly { readonly worker_id: string }[] };
  readonly sessionJournal: AcpSessionJournal;
  readonly githubGateway?: RedskilledGithubGatewayRegistration;
  readonly evidenceRoot?: string;
  readonly evidenceTtlMs?: number;
  readonly workspaceRoot?: string;
  /**
   * How a Worker is admitted for this turn.
   *
   * Defaults to the same native admission every client turn uses; a test
   * substitutes it, because the alternative is spawning a real coder agent to
   * assert that a prompt was sent.
   */
  readonly admit?: (input: DemandTurnAdmission) => Promise<ActiveWorkflowWorker>;
  /**
   * Where a lifecycle line goes when there is no client to notify.
   *
   * An unattended turn must be exactly as observable as an attended one, or the
   * only way to learn a drain is working is to watch for commits.
   */
  readonly record?: (line: DemandTurnRecord) => void;
  /**
   * What happens to the Ticket after a completed turn whose gate blocked.
   *
   * Answers a one-line record of the transition it performed (or refused), or
   * `null` for every other verdict. Absent in tests that assert the turn
   * alone; the control plane wires `parkGateBlockedTurn` (#4160), because a
   * gate-blocked Ticket left in the ready queue is re-taken by the very next
   * birth — the infinite grinder the park exists to end.
   */
  readonly park?: (
    project: AcpProjectWorkspace,
    ticket: Readonly<Record<string, unknown>>,
    response: PromptResponse,
    workerId: string,
  ) => Promise<string | null>;
  /**
   * Where a turn's session updates land as Worker liveness (#4181).
   *
   * A native Worker publishes no heartbeat op, so without this every statusline
   * row reads `hb=?` while the turn streams. The runner stamps the work item at
   * admission and each update's text line as it arrives.
   */
  readonly pulse?: (pulse: { workerId: string; line?: string; issue?: string; phase?: string; step?: string }) => void;
}

/**
 * What one turn's answer says happened. PURE.
 *
 * **A Ticket turn states its verdict in `_meta.redskills.ticket`, and sets
 * `workflowOutcome` only when it LANDED** — so a record that read the workflow
 * outcome alone printed `no-workflow-outcome (end_turn)` for a landed-less
 * turn and for a refusal alike, hiding the stage and the reason the Worker had
 * already written down. Read the verdict first; fall back to the stop reason
 * for the ordinary prompt turns that carry none.
 */
export function describeTurnOutcome(response: PromptResponse): string {
  const ticket = (response._meta as { redskills?: { ticket?: unknown } } | undefined)?.redskills?.ticket;
  const verdict = ticket == null || typeof ticket !== "object"
    ? undefined
    : (ticket as { outcome?: unknown; stage?: unknown; failedStage?: unknown; detail?: unknown });
  if (verdict?.outcome != null) {
    const where = verdict.stage ?? verdict.failedStage;
    return `${String(verdict.outcome)}` +
      `${where == null ? "" : ` at ${String(where)}`}` +
      `${verdict.detail == null ? "" : `: ${String(verdict.detail)}`}`;
  }
  return `${workflowOutcome(response) ?? "no-workflow-outcome"} (${response.stopReason})`;
}

/**
 * What the last poll knows about the item a birth is for. PURE.
 *
 * Beside the handoff it feeds rather than in the demand loop: the lifecycle
 * decides that a birth happens, never what the Worker is told about it.
 */
export function queueBriefing(
  projects: readonly {
    readonly project_label: string;
    readonly tickets?: readonly { readonly id: string; readonly title: string; readonly labels: readonly string[] }[];
  }[],
  projectLabel: string,
  workItem: string | undefined,
): { readonly id: string; readonly title: string; readonly labels: readonly string[] } | undefined {
  if (workItem == null) return undefined;
  return projects.find((project) => project.project_label === projectLabel)
    ?.tickets?.find((candidate) => candidate.id === workItem);
}

/**
 * The turn one birth owes, or `null` when this project states no prompt.
 *
 * Pure and separate from the loop that calls it, because the interesting part
 * is not the plumbing: it is that a project which said nothing births exactly
 * as it always did, and a template naming a fact this birth does not have is
 * refused BEFORE anything is spawned. PURE.
 *
 * @param standingOrders - Optional standing orders to prepend to the prompt
 */
export function demandTurnForBirth(
  registration: {
    readonly prompt?: string;
    readonly trunk?: { readonly branch: string };
    readonly validation_commands?: readonly string[];
    readonly argv?: readonly string[];
  } | undefined,
  birth: { readonly workspace_path: string; readonly index: number; readonly work_item?: string },
  workerId: string,
  ticket?: { readonly id: string; readonly title: string; readonly labels: readonly string[] },
  standingOrders?: string,
): {
  readonly workspacePath: string;
  readonly prompt: string;
  readonly workItem?: string;
  readonly runner?: AcpAgentId;
  readonly ticket?: Readonly<Record<string, unknown>>;
} | null {
  if (registration?.prompt == null) return null;
  const runner = runnerFromLaunchArgv(registration.argv);
  const expanded = expandLaunchTemplate({ argv: [registration.prompt] }, {
    worker_id: workerId,
    slot: birth.index,
    workspace_path: birth.workspace_path,
    ...(birth.work_item == null ? {} : { work_item: birth.work_item }),
  }).argv[0]!;
  // Prepend standing orders to the prompt if present
  const withOrders = standingOrders != null && standingOrders !== ""
    ? `${standingOrders}\n${expanded}`
    : expanded;
  // The handoff is stated only when every fact it requires is present: a Ticket
  // briefed with an empty title or no trunk is one the Worker refuses, and a
  // refusal the daemon could have avoided is a Worker born to fail.
  const number = Number(ticket?.id);
  const base = registration.trunk?.branch;
  const briefed = ticket != null && Number.isInteger(number) && number > 0 &&
    ticket.title !== "" && base != null && base !== "";
  return {
    workspacePath: birth.workspace_path,
    prompt: withOrders,
    ...(birth.work_item == null ? {} : { workItem: birth.work_item }),
    ...(runner == null ? {} : { runner }),
    ...(briefed
      ? {
        ticket: {
          number,
          title: ticket!.title,
          labels: [...ticket!.labels],
          base: base!,
          handoff: withOrders,
          worker_id: workerId,
          ...(registration.validation_commands == null || registration.validation_commands.length === 0
            ? {}
            : { validation_commands: [...registration.validation_commands] }),
        },
      }
      : {}),
  };
}

/**
 * The runner a registration's launch argv declares; null when it declares none.
 *
 * The argv is the registration's stated launch (Amendment 5), and `--child-agent`
 * is the one token in it that names a runner. Reading the pair here keeps the
 * daemon shape-checking: an unknown name is no declaration, never an error.
 */
export function runnerFromLaunchArgv(argv: readonly string[] | undefined): AcpAgentId | null {
  if (argv == null) return null;
  const at = argv.indexOf("--child-agent");
  const candidate = at >= 0 ? argv[at + 1] : undefined;
  return candidate != null && (ACP_AGENT_IDS as readonly string[]).includes(candidate)
    ? (candidate as AcpAgentId)
    : null;
}

/** What one admission needs, whoever performs it. */
export interface DemandTurnAdmission {
  readonly project: AcpProjectWorkspace;
  readonly sessionId: string;
  /** The runner the registration declared for this birth; admission defaults when absent. */
  readonly runner?: AcpAgentId;
  readonly notify: AgentConnection["client"]["notify"];
  readonly permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  readonly replacement: boolean;
}

export interface DemandTurnRecord {
  readonly event: string;
  readonly project_label: string;
  readonly worker_id?: string;
  readonly work_item?: string;
  readonly detail?: string;
}

/**
 * One unattended turn's outcome as a line an operator reads. PURE.
 *
 * Lives beside the record it renders rather than at the journal call site: the
 * daemon's lifecycle decides WHERE narration goes, never what it says.
 */
export function describeDemandTurn(record: DemandTurnRecord): string {
  return (
    `redskilled: unattended turn ${record.event} for project ${JSON.stringify(record.project_label)}` +
    `${record.work_item == null ? "" : ` on item ${record.work_item}`}` +
    `${record.worker_id == null ? "" : ` (worker ${record.worker_id})`}` +
    `${record.detail == null ? "" : `: ${record.detail}`}\n`
  );
}

export interface DemandTurnRequest {
  readonly project: AcpProjectWorkspace;
  /** The project's prompt, with this birth's facts already written into it. */
  readonly prompt: string;
  /** The queue identifier this turn is for, when the birth had one. */
  readonly workItem?: string;
  /** The runner the registration's launch declared; admission's default when absent. */
  readonly runner?: AcpAgentId;
  /**
   * The Ticket this Worker is briefed with (#4118's first drain).
   *
   * **A Worker enters its Ticket loop only through a handoff.** Without one the
   * body takes its third path — echo the prompt back and end the turn — which
   * is exactly what every unattended turn did: `no-workflow-outcome (end_turn)`
   * in under a second, a fresh Worker every fifteen. The handoff is the same
   * wire a client dispatch uses; the daemon states it and reads none of it.
   */
  readonly ticket?: Readonly<Record<string, unknown>>;
}

export interface DemandTurnResult {
  readonly workerId: string;
  readonly outcome: string;
}

/**
 * A permission request with nobody to ask.
 *
 * **Refused, and said out loud.** A daemon that answered "approved" on an
 * operator's behalf would be granting, unattended, exactly the reach an
 * attached client is shown a dialog for; one that hung would hold a Worker
 * open until its idle timer. The Worker sees a refusal it can park on.
 */
export const DEMAND_TURN_PERMISSION_REFUSAL =
  "this turn runs unattended: redskilled refuses permission on nobody's behalf — park the work for /hitl instead";

function refusePermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const cancelled = request.options.find((option) => option.kind === "reject_once")
    ?? request.options.find((option) => option.kind === "reject_always");
  return cancelled == null
    ? { outcome: { outcome: "cancelled" }, _meta: { redskills: { permissionResolution: "unattended-refused" } } }
    : {
      outcome: { outcome: "selected", optionId: cancelled.optionId },
      _meta: { redskills: { permissionResolution: "unattended-refused", reason: DEMAND_TURN_PERMISSION_REFUSAL } },
    };
}

/**
 * Bind a runner from the control plane's own options, so the assembler states
 * the dependency once instead of restating every optional field. PURE wiring.
 */
export function demandTurnRunnerFor(
  options: {
    readonly paths: RedskilledPaths;
    readonly startWorker: (spec: RedskilledWorkerSpec) => LaunchedWorker;
    readonly hostState: () => { readonly workers: readonly { readonly worker_id: string }[] };
    readonly githubGateway?: RedskilledGithubGatewayRegistration;
    readonly evidenceRoot?: string;
    readonly evidenceTtlMs?: number;
    readonly recordDemandTurn?: (record: DemandTurnRecord) => void;
    readonly workerPulse?: (pulse: { workerId: string; line?: string; issue?: string }) => void;
  },
  sessionJournal: AcpSessionJournal,
): (request: DemandTurnRequest) => Promise<DemandTurnResult> {
  return createDemandTurnRunner({
    paths: options.paths,
    startWorker: options.startWorker,
    hostState: options.hostState,
    sessionJournal,
    ...(options.githubGateway == null ? {} : { githubGateway: options.githubGateway }),
    ...(options.evidenceRoot == null ? {} : { evidenceRoot: options.evidenceRoot }),
    ...(options.evidenceTtlMs == null ? {} : { evidenceTtlMs: options.evidenceTtlMs }),
    ...(options.recordDemandTurn == null ? {} : { record: options.recordDemandTurn }),
    ...(options.workerPulse == null ? {} : { pulse: options.workerPulse }),
    park: parkGateBlockedTurn(options.githubGateway),
  });
}

/**
 * The synthetic `session/new` an unattended turn admits its Worker with. PURE.
 *
 * Admission reads the runner from the SESSION request's meta — the prompt
 * request's meta never reaches it — so the declared runner must be restated
 * here or every unattended Worker silently falls back to admission's default
 * (the first live codex drain was born redcode exactly this way).
 */
export function demandAdmissionSessionRequest(
  input: Pick<DemandTurnAdmission, "project" | "runner">,
): NewSessionRequest {
  return {
    cwd: input.project.workspacePath,
    mcpServers: [],
    ...(input.runner == null ? {} : { _meta: { redskills: { runner: input.runner } } }),
  };
}

/**
 * Bind the daemon's unattended turn runner.
 *
 * One `active` map per runner, held for the daemon's life: a Worker admitted
 * for one work item is reaped when its turn ends, so the map never holds more
 * than the turns actually in flight.
 */
export function createDemandTurnRunner(
  deps: DemandTurnDeps,
): (request: DemandTurnRequest) => Promise<DemandTurnResult> {
  const active = new Map<string, ActiveWorkflowWorker>();
  let sequence = 0;
  // Unique across daemon lifetimes: the sequence alone restarts at zero with
  // the process, so `demand-3-<project>` recurred after every restart and the
  // publication outbox replayed the PREVIOUS boot's durable receipt for the
  // same idempotency scope — a publish that "succeeded" without pushing, and a
  // land that 422'd on a head no push had created.
  const runnerNonce = randomBytes(4).toString("hex");
  const admit = deps.admit ?? ((input: DemandTurnAdmission) => admitNativeAcpWorker(
    {
      paths: deps.paths,
      startWorker: deps.startWorker,
      hostState: deps.hostState,
      ...(deps.workspaceRoot == null ? {} : { workspaceRoot: deps.workspaceRoot }),
      ...(deps.evidenceRoot == null ? {} : { evidenceRoot: deps.evidenceRoot }),
      ...(deps.evidenceTtlMs == null ? {} : { evidenceTtlMs: deps.evidenceTtlMs }),
      ...(deps.githubGateway == null ? {} : { githubGateway: deps.githubGateway }),
    },
    deps.sessionJournal,
    { request: demandAdmissionSessionRequest(input), project: input.project },
    input.sessionId,
    input.notify,
    input.permission,
    input.replacement,
  ));

  return async (request: DemandTurnRequest): Promise<DemandTurnResult> => {
    sequence += 1;
    // Synthetic and unique per turn: the session id keys the admission map and
    // the journal, and a reused one would make two unattended turns look like
    // one session being replaced.
    const sessionId = `demand-${runnerNonce}-${sequence}-${request.project.projectId}`;
    const record = (event: string, worker?: ActiveWorkflowWorker, detail?: string): void => {
      deps.record?.({
        event,
        project_label: request.project.projectLabel,
        ...(worker == null ? {} : { worker_id: worker.workerId }),
        ...(request.workItem == null ? {} : { work_item: request.workItem }),
        ...(detail == null ? {} : { detail }),
      });
    };
    // Nobody is listening, so a notification is a record — and a pulse (#4181):
    // the turn's own updates are the only liveness a native Worker ever emits.
    let born: ActiveWorkflowWorker | null = null;
    const notify: AgentConnection["client"]["notify"] = async (_method: string, params?: unknown) => {
      if (born == null || deps.pulse == null) return;
      const line = sessionUpdateLine(params);
      const stage = sessionUpdateStage(params);
      deps.pulse({
        workerId: born.workerId,
        ...(line == null ? {} : { line }),
        ...(stage == null ? {} : { phase: stage.phase, ...(stage.step == null ? {} : { step: stage.step }) }),
      });
    };

    try {
      // **A turn nobody opened is a turn the journal refuses.** Admission and
      // every checkpoint key off a durable session record, so an unattended
      // turn has to open its own exactly as `session/new` opens a client's —
      // otherwise the demand loop reaches admission and dies on "unknown
      // durable RedSkills ACP session", which is a birth nobody can explain
      // from the outside (observed on 4.0.2, issue #4118's first drain).
      await deps.sessionJournal.create(sessionId, request.project);
      const { worker, response } = await requestWorkflowTurn(
        sessionId,
        active,
        {
          sessionId,
          prompt: [{ type: "text", text: request.prompt }],
          _meta: {
            redskills: {
              unattended: true,
              ...(request.workItem == null ? {} : { workItem: request.workItem }),
              ...(request.runner == null ? {} : { runner: request.runner }),
              ...(request.ticket == null ? {} : { ticket: request.ticket }),
            },
          },
        },
        (replacement) => admit({
          project: request.project,
          sessionId,
          ...(request.runner == null ? {} : { runner: request.runner }),
          notify,
          permission: async (permission) => refusePermission(permission),
          replacement,
        }).then((worker) => {
          born = worker;
          deps.pulse?.({ workerId: worker.workerId, ...(request.workItem == null ? {} : { issue: `#${request.workItem}` }) });
          return worker;
        }),
      );
      const outcome = describeTurnOutcome(response);
      record("demand-turn-completed", worker, outcome);
      if (deps.park != null && request.ticket != null) {
        try {
          const parked = await deps.park(request.project, request.ticket, response, worker.workerId);
          if (parked != null) record("demand-park", worker, parked);
        } catch (error) {
          record("demand-park-failed", worker, error instanceof Error ? error.message : String(error));
        }
      }
      // The turn is the Worker's whole life: it was admitted for one work item
      // and has now finished it, so it is reaped here rather than left on an
      // idle timer nobody will come back to.
      cleanupWorkflowWorker(sessionId, worker, active, outcome);
      return { workerId: worker.workerId, outcome };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record("demand-turn-refused", active.get(sessionId), detail);
      const held = active.get(sessionId);
      if (held != null) cleanupWorkflowWorker(sessionId, held, active, "demand-turn-refused");
      throw error;
    }
  };
}

/** The Ticket stage a session update carries (#4181 v2): the statusline's phase cell. PURE. */
function sessionUpdateStage(params: unknown): { phase: string; step?: string } | null {
  const stage = (params as { _meta?: { redskills?: { ticketStage?: unknown } } } | undefined)
    ?._meta?.redskills?.ticketStage;
  if (stage == null || typeof stage !== "object") return null;
  const record = stage as { stage?: unknown; ok?: unknown; round?: unknown };
  if (typeof record.stage !== "string" || record.stage === "") return null;
  return {
    phase: record.ok === false ? `${record.stage}!` : record.stage,
    ...(typeof record.round === "number" ? { step: `round ${record.round}` } : {}),
  };
}

/** The text a session update carries, when it carries any. PURE. */
function sessionUpdateLine(params: unknown): string | null {
  const update = (params as { update?: { content?: { text?: unknown } } } | undefined)?.update;
  const text = update?.content?.text;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}
