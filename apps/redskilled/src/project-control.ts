import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  methods,
  RequestError,
  type AgentConnection,
} from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import {
  acpNoParams,
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { RedskilledDemandOutcome } from "./demand-loop.js";
import type { RedskilledHostState } from "./host-state.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { REDSKILLED_QUEUE_STALENESS_MS } from "./queue-discovery.js";

export const PROJECT_CONTROL_METHODS = [
  REDSKILLS_ACP_METHODS.projectDrain,
  REDSKILLS_ACP_METHODS.projectStop,
  REDSKILLS_ACP_METHODS.projectStatus,
] as const;

export type ProjectControlOperation = "drain" | "stop";
export type ProjectControlCommand = ProjectControlOperation | "status";
type ProjectDrainIntent = "inactive" | "draining" | "stopped";
export type ProjectControlOperationStatus = "draining" | "already-draining" | "stopped" | "already-stopped";
export type ProjectStatusFreshness = "fresh" | "stale" | "unknown";

export interface ProjectStatusContext {
  readonly version: 1;
  readonly observed_at: string;
  readonly queue: {
    readonly posture: RedskilledDemandOutcome | "queued" | "unknown";
    readonly depth: number | null;
    readonly target: number | null;
    readonly live: number;
    readonly wanted: number | null;
    readonly observed_at: string | null;
    readonly age_ms: number | null;
    readonly freshness: ProjectStatusFreshness;
    readonly detail: string;
    /** Whether a registration — the thing the demand loop polls — is held. */
    readonly registered: boolean;
    /**
     * The identifiers the last poll counted (#4098), when its transport listed
     * them. Reported so an operator can see WHAT the daemon believes is queued,
     * not only how much. Opaque here as everywhere: never parsed.
     */
    readonly items: readonly string[];
  };
  readonly workers: {
    readonly total: number;
    readonly freshness: "fresh";
    readonly observed_at: string;
    readonly items: readonly {
      readonly worker_id: string;
      readonly state: "running";
      readonly started_at: string;
      readonly isolated: boolean;
      readonly warnings: readonly string[];
      readonly base_commits_ahead: number | null;
    }[];
  };
  readonly adapter_health: {
    readonly status: "healthy" | "degraded" | "unknown";
    readonly checked_at: string | null;
    readonly last_success_at: string | null;
    readonly last_failure_at: string | null;
    readonly detail: string;
  };
}

interface ProjectControlUpdate {
  readonly sequence: number;
  readonly operation: ProjectControlOperation;
  readonly drain_intent: Exclude<ProjectDrainIntent, "inactive">;
}

export interface ProjectControlState {
  readonly drainIntent: ProjectDrainIntent;
  readonly revision: number;
  readonly updates: readonly ProjectControlUpdate[];
  /** The width the caller asked for, carried and echoed, never interpreted. */
  readonly target?: number;
  /** The runner the caller named, opaque in exactly the sense the argv is. */
  readonly runner?: string;
}

interface ProjectControlStoreSnapshot {
  readonly version: 1;
  readonly projects: readonly {
    readonly project_id: string;
    readonly state: ProjectControlState;
  }[];
}

export interface ProjectControlStore {
  read(): Promise<Map<string, ProjectControlState>>;
  replace(projects: ReadonlyMap<string, ProjectControlState>): Promise<void>;
}

interface ProjectControlSession {
  readonly project: AcpProjectWorkspace;
}

export function projectControlSnapshot(
  project: AcpProjectWorkspace,
  projectControls: Map<string, ProjectControlState>,
) {
  const control = projectControls.get(project.projectId) ?? {
    drainIntent: "inactive" as const,
    revision: 0,
    updates: [],
  };
  return {
    version: 1 as const,
    project_id: project.projectId,
    project_label: project.projectLabel,
    workspace_path: project.workspacePath,
    drain_intent: control.drainIntent,
    revision: control.revision,
    // Echoed so a caller can SEE that the width it asked for arrived. A control
    // call whose argument vanished silently is indistinguishable from one that
    // was honoured.
    requested_target: control.target ?? null,
    requested_runner: control.runner ?? null,
    updates: [...control.updates],
  };
}

/** Project-safe status derived from one daemon read; no adapter performs its own observation. */
export function projectStatusSnapshot(
  project: AcpProjectWorkspace,
  projectControls: Map<string, ProjectControlState>,
  host: RedskilledHostState,
  observedAt: string,
) {
  const workers = host.workers
    .filter((worker) => worker.project_label === project.projectLabel)
    .sort((left, right) => left.worker_id.localeCompare(right.worker_id));
  const registration = host.registrations?.find((entry) => entry.project_label === project.projectLabel);
  const intent = host.demand?.projects.find((entry) => entry.project_label === project.projectLabel);
  const poll = registration?.last_poll;
  const ageMs = ageBetween(observedAt, poll?.at);
  const freshness: ProjectStatusFreshness = poll == null || ageMs == null
    ? "unknown"
    : ageMs > REDSKILLED_QUEUE_STALENESS_MS
      ? "stale"
      : "fresh";
  const depth = poll?.outcome === "counted" ? poll.depth : null;
  const posture = intent?.outcome ?? (depth == null ? "unknown" : depth === 0 ? "queue-drained" : "queued");
  // **A drain that cannot drain has to say so.** Drain intent lives on the
  // control record; the demand loop births only for a REGISTRATION, which names
  // the work query and the argv a Worker is launched with. A project that is
  // `draining` with no registration therefore polls nothing and births nothing
  // — and reported that as "the daemon has not observed this Project queue",
  // which reads like a freshness lag that will clear on its own. It never
  // clears: nothing is going to observe it.
  const drainIntent = (projectControls.get(project.projectId)?.drainIntent) ?? "inactive";
  const unregisteredDrain = registration == null && drainIntent === "draining";
  const health = host.request_health;

  const context: ProjectStatusContext = {
    version: 1,
    observed_at: observedAt,
    queue: {
      posture,
      depth,
      target: intent?.target ?? registration?.target ?? null,
      live: workers.length,
      wanted: intent?.wanted ?? null,
      observed_at: poll?.at ?? null,
      age_ms: ageMs,
      freshness,
      detail: unregisteredDrain
        ? UNREGISTERED_DRAIN_WARNING
        : intent?.detail ?? poll?.detail ?? "the daemon has not observed this Project queue",
      registered: registration != null,
      items: [...(poll?.items ?? [])],
    },
    workers: {
      total: workers.length,
      freshness: "fresh",
      observed_at: observedAt,
      items: workers.map((worker) => ({
        worker_id: worker.worker_id,
        state: "running",
        started_at: worker.started_at,
        isolated: worker.isolated,
        warnings: [...worker.warnings],
        base_commits_ahead: worker.base_commits_ahead ?? null,
      })),
    },
    adapter_health: health == null
      ? {
          status: "unknown",
          checked_at: null,
          last_success_at: null,
          last_failure_at: null,
          detail: "the daemon has not published request-lane health",
        }
      : {
          status: health.status,
          checked_at: health.last_probe_at,
          last_success_at: health.last_success_at,
          last_failure_at: health.last_failure_at,
          detail: health.detail,
        },
  };
  return { ...projectControlSnapshot(project, projectControls), context };
}

export async function applyProjectControl(
  project: AcpProjectWorkspace,
  operation: ProjectControlOperation,
  projectControls: Map<string, ProjectControlState>,
  persist: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>,
  request: { readonly target?: number; readonly runner?: string } = {},
) {
  const held = projectControls.get(project.projectId);
  if (held == null && operation === "stop") {
    return { ...projectControlSnapshot(project, projectControls), status: "already-stopped" as const };
  }
  const observed = held ?? {
    drainIntent: "inactive" as const,
    revision: 0,
    updates: [],
  };
  const requestedIntent = operation === "drain" ? "draining" as const : "stopped" as const;
  const target = request.target ?? observed.target;
  const runner = request.runner ?? observed.runner;
  const restated = target !== observed.target || runner !== observed.runner;
  if (observed.drainIntent === requestedIntent && !restated) {
    const status = operation === "drain" ? "already-draining" as const : "already-stopped" as const;
    return { ...projectControlSnapshot(project, projectControls), status };
  }
  const revision = observed.revision + 1;
  const next = new Map(projectControls);
  next.set(project.projectId, {
    drainIntent: requestedIntent,
    revision,
    updates: [...observed.updates, { sequence: revision, operation, drain_intent: requestedIntent }],
    ...(target == null ? {} : { target }),
    ...(runner == null ? {} : { runner }),
  });
  await persist(next);
  projectControls.set(project.projectId, next.get(project.projectId)!);
  return { ...projectControlSnapshot(project, projectControls), status: requestedIntent };
}

export function projectControlStorePath(registrationIntentPath: string): string {
  return join(dirname(registrationIntentPath), "redskilled.project-control.toon");
}

export function createProjectControlStore(path: string): ProjectControlStore {
  let tail: Promise<void> = Promise.resolve();

  return {
    async read() {
      await tail;
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw error;
      }
      const parsed = parseStoreSnapshot(raw);
      if (!isStoreSnapshot(parsed)) return new Map();
      return new Map(parsed.projects.map(({ project_id, state }) => [project_id, state]));
    },
    replace(projects) {
      const snapshot: ProjectControlStoreSnapshot = {
        version: 1,
        projects: [...projects].map(([project_id, state]) => ({ project_id, state })),
      };
      tail = tail.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${encode(snapshot as unknown as JsonValue)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, path);
      });
      return tail;
    },
  };
}

/**
 * The verb a control prompt names, and the arguments it carries.
 *
 * **A verb and its arguments arrive on one line, so the matcher must read
 * both.** The client renders every parameterised call as `/<verb> {json}`
 * (`project-acp-adapter.ts`), while this matcher used to demand a BARE verb —
 * so `/drain {"target":2}` matched nothing, fell through to "execute this
 * prompt in a Worker", and came back as narration with no answer in it. Two
 * halves of one wire disagreeing is not a Worker failure; it reads like one.
 *
 * Arguments stay OPAQUE in the sense rule 3 requires: the daemon carries a
 * target width and a runner name, and asks nothing about what either means.
 */
export interface ProjectControlInvocation {
  readonly operation: ProjectControlCommand;
  readonly target?: number;
  readonly runner?: string;
}

const CONTROL_VERB: ReadonlyMap<string, ProjectControlCommand> = new Map([
  ["drain", "drain"],
  ["project_drain", "drain"],
  ["stop", "stop"],
  ["project_stop", "stop"],
  ["status", "status"],
  ["project_status", "status"],
]);

export function coreProjectOperation(prompt: unknown): ProjectControlCommand | undefined {
  return coreProjectInvocation(prompt)?.operation;
}

/** The verb plus whatever the caller passed with it. PURE. */
export function coreProjectInvocation(prompt: unknown): ProjectControlInvocation | undefined {
  const text = promptBlocksText(prompt).trim();
  const brace = text.indexOf("{");
  const head = (brace < 0 ? text : text.slice(0, brace)).trim().toLowerCase();
  const operation = CONTROL_VERB.get(head.startsWith("/") ? head.slice(1) : head);
  if (operation == null) return undefined;
  if (brace < 0) return { operation };
  const args = record(parseJson(text.slice(brace)));
  if (args == null) return { operation };
  const target = typeof args.target === "number" && Number.isInteger(args.target) && args.target >= 0
    ? args.target
    : undefined;
  const runner = typeof args.runner === "string" && args.runner.length > 0 ? args.runner : undefined;
  return {
    operation,
    ...(target == null ? {} : { target }),
    ...(runner == null ? {} : { runner }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function promptBlocksText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => record(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export async function notifyV1ProjectControl(
  upstream: AgentConnection["client"],
  sessionId: string,
  operation: ProjectControlCommand,
  control: { readonly drain_intent: ProjectDrainIntent; readonly revision: number },
): Promise<void> {
  await upstream.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "plan",
      entries: [{
        content: operation === "status"
          ? "Observe the Project status"
          : `${operation === "drain" ? "Continue" : "Stop"} the Project drain`,
        priority: "high",
        status: "completed",
      }],
    },
  });
  await upstream.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Project drain intent is ${control.drain_intent} at revision ${control.revision}\n`,
      },
    },
  });
}

/**
 * Answer one v1 prompt that IS a control verb, or `null` when it is not.
 *
 * The v1 twin of {@link runV2ProjectControlTurn}, and it lives beside it for
 * the same reason: a control verb is answered by the control surface, never by
 * birthing a Worker to read the prompt back to the caller.
 */
export async function runV1ProjectControlTurn(
  params: { readonly sessionId: string; readonly prompt: unknown },
  upstream: AgentConnection["client"],
  project: AcpProjectWorkspace,
  control: {
    readonly mutate: (
      operation: ProjectControlOperation,
      request: ProjectControlRequest,
    ) => Promise<{ readonly drain_intent: ProjectDrainIntent; readonly revision: number }>;
    readonly read: (project: AcpProjectWorkspace) => Promise<
      { readonly drain_intent: ProjectDrainIntent; readonly revision: number }
    >;
  },
): Promise<{ stopReason: "end_turn"; _meta: Record<string, unknown> } | null> {
  const invocation = coreProjectInvocation(params.prompt);
  if (invocation == null) return null;
  const operation = invocation.operation;
  const answer = operation === "status"
    ? await control.read(project)
    : await control.mutate(operation, { target: invocation.target, runner: invocation.runner });
  await notifyV1ProjectControl(upstream, params.sessionId, operation, answer);
  return {
    stopReason: "end_turn",
    _meta: { redskills: { authority: "redskilled", projectControl: answer } },
  };
}

export async function runV2ProjectControlTurn(
  sessions: ReadonlyMap<string, ProjectControlSession>,
  params: acpV2.PromptRequest,
  upstream: acpV2.AgentContext,
  invocation: ProjectControlInvocation,
  projectControls: Map<string, ProjectControlState>,
  persist: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>,
  readStatus: (project: AcpProjectWorkspace) => Promise<ReturnType<typeof projectStatusSnapshot>>,
): Promise<void> {
  const session = sessions.get(params.sessionId);
  if (session == null) return;
  const operation = invocation.operation;
  const control = operation === "status"
    ? await readStatus(session.project)
    : await applyProjectControl(session.project, operation, projectControls, persist, {
        target: invocation.target,
        runner: invocation.runner,
      });
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "project-control",
        entries: [{
          content: operation === "status"
            ? "Observe the Project status"
            : `${operation === "drain" ? "Continue" : "Stop"} the Project drain`,
          priority: "high",
          status: "completed",
        }],
      },
    },
  });
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    _meta: { redskills: { authority: "redskilled", projectControl: control } },
  });
}

function ageBetween(now: string, observed: string | undefined): number | null {
  if (observed == null) return null;
  const nowMs = Date.parse(now);
  const observedMs = Date.parse(observed);
  return Number.isFinite(nowMs) && Number.isFinite(observedMs)
    ? Math.max(0, nowMs - observedMs)
    : null;
}

function parseStoreSnapshot(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return decode(body);
  } catch {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
}

function isStoreSnapshot(value: unknown): value is ProjectControlStoreSnapshot {
  const snapshot = record(value);
  return snapshot?.version === 1 &&
    Array.isArray(snapshot.projects) &&
    snapshot.projects.every((entry) => {
      const project = record(entry);
      const state = record(project?.state);
      return typeof project?.project_id === "string" &&
        (state?.drainIntent === "inactive" || state?.drainIntent === "draining" || state?.drainIntent === "stopped") &&
        typeof state.revision === "number" &&
        Array.isArray(state.updates);
    });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** What a control method may be asked for. Shape is checked; meaning never is. */
export interface ProjectControlRequest {
  readonly target?: number;
  readonly runner?: string;
  /**
   * The work this project wants drained, authored by the project (#4101).
   *
   * **A drain intent nobody registered polls nothing.** The demand loop births
   * for a registration — the record carrying the query, the workspace, the argv
   * and the prompt — and until a drain could carry one, every drain recorded an
   * intention and produced no Worker. The daemon reads none of it: the fields
   * are the ones `project-register` already carries, and they arrive here
   * because a client that says "drain" is exactly the client that knows what
   * its work is.
   */
  readonly registration?: Readonly<Record<string, unknown>>;
}

/**
 * Read a control request off the wire.
 *
 * Permissive in the same way `acpNoParams` is — an unknown key is not an error,
 * because tightening a method that has accepted any object is its own slice —
 * but a `target` or `runner` that IS present must be usable, or the caller
 * would read a healthy answer for a width that never arrived.
 */
export function projectControlRequest(value: unknown): ProjectControlRequest {
  const params = record(value);
  if (params == null) return {};
  const { target, runner } = params;
  if (target !== undefined && !(typeof target === "number" && Number.isInteger(target) && target >= 0)) {
    throw RequestError.invalidParams("target must be a non-negative integer");
  }
  if (runner !== undefined && !(typeof runner === "string" && runner.length > 0)) {
    throw RequestError.invalidParams("runner must be a non-empty string");
  }
  const registration = params.registration;
  if (registration !== undefined && record(registration) == null) {
    throw RequestError.invalidParams("registration must be an object");
  }
  return {
    ...(target === undefined ? {} : { target: target as number }),
    ...(runner === undefined ? {} : { runner: runner as string }),
    ...(registration === undefined ? {} : { registration: registration as Readonly<Record<string, unknown>> }),
  };
}

/**
 * Bind one connection's Project control pair: the mutation and the status read.
 *
 * Both close over the same scoped Project, the same control map and the same
 * persistence, so they belong beside the record they operate on rather than in
 * the connection assembler — which is a wiring file, not a control surface.
 */
/**
 * What a `drain` answers when nothing will act on it.
 *
 * Stated once, so the status projection and the control answer cannot drift
 * into two different accounts of one dead end.
 */
export const UNREGISTERED_DRAIN_WARNING =
  "this Project holds no registration, so the daemon polls no queue and births no Worker for it;" +
  " the drain intent is recorded and nothing acts on it";

/** Whether a registration failed because the daemon already holds one. PURE. */
function isProjectAlreadyRegistered(error: unknown): boolean {
  return error instanceof Error && error.name === "RedskilledProjectRegisteredError";
}

/** Whether the daemon holds the registration its demand loop would poll. PURE. */
export function projectIsRegistered(host: RedskilledHostState, project: AcpProjectWorkspace): boolean {
  return (host.registrations ?? []).some((entry) => entry.project_label === project.projectLabel);
}

export function bindProjectControl(deps: {
  readonly scopedProject: () => AcpProjectWorkspace;
  readonly projectControls: Map<string, ProjectControlState>;
  readonly persistProjectControls: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>;
  readonly hostState: () => RedskilledHostState;
  readonly clock: () => string;
  readonly readGithubCustody: () => Promise<unknown>;
  /** The daemon's own registration path; absent means this endpoint cannot register. */
  readonly registerProject?: (request: Readonly<Record<string, unknown>>) => unknown;
  /** The daemon's own release path; a stop hands the registration back through it. */
  readonly releaseProject?: (projectLabel: string) => unknown;
}) {
  return {
    mutateProjectControl: async (operation: ProjectControlOperation, request: ProjectControlRequest = {}) => {
      const project = deps.scopedProject();
      // Registered BEFORE the intent is written: a drain that recorded
      // "draining" and then failed to register would be exactly the dead end
      // #4094 had to announce, with the announcement now saying the opposite of
      // what the caller was told.
      if (operation === "drain" && request.registration != null) {
        if (deps.registerProject == null) {
          throw new Error("this endpoint cannot register a project: the daemon handed it no registration path");
        }
        try {
          // **One key, both sides of the ledger — and the label IS the key.**
          // #4152 records the admitted Worker under `project.projectLabel`,
          // which is what the registration store, the demand loop's live count
          // and queue discovery all key by. This site briefly registered under
          // `projectId` (#4146) while Workers carried the label, so the planner
          // never counted its own children: target 1 ran five Workers and the
          // host ceiling was the only brake (#4158). The registration registers
          // under the same key its Workers carry.
          deps.registerProject({ ...request.registration, project_label: project.projectLabel });
        } catch (error) {
          // **A drain is idempotent; a registration is not.** `project-register`
          // refuses a second record so two sessions cannot silently replace each
          // other's work, but a drain re-run by the same operator — or by a new
          // session repairing a standing declaration — must not fail for saying
          // the same thing twice. A record already held IS the answer.
          if (!isProjectAlreadyRegistered(error)) throw error;
        }
      }
      const answer = await applyProjectControl(
        project,
        operation,
        deps.projectControls,
        deps.persistProjectControls,
        request,
      );
      // **A stop hands the registration back, not only the intent.** The
      // registration is self-sustained off open work (ADR 0130 Amendment 7), so
      // a stop that flips the intent and leaves the record standing is a drain
      // the operator cannot end: the sustain renews it, the demand loop keeps
      // planning off it, and Workers keep being born after the operator said
      // stop (#4159). Released through the same path `project-deregister` uses;
      // releasing an already-released project states the outcome and is not an
      // error, which is what makes a repeated stop safe.
      if (operation === "stop") deps.releaseProject?.(project.projectLabel);
      // Told at the moment of asking, not only to whoever thinks to read status
      // afterwards: a caller who ran `drain` and got a clean answer has every
      // reason to believe Workers are coming.
      return operation === "drain" && !projectIsRegistered(deps.hostState(), project)
        ? { ...answer, warning: UNREGISTERED_DRAIN_WARNING }
        : answer;
    },
    readProjectStatus: async (project: AcpProjectWorkspace) => {
      const control = projectStatusSnapshot(project, deps.projectControls, deps.hostState(), deps.clock());
      const mergeCustody = await deps.readGithubCustody();
      return mergeCustody == null ? control : { ...control, merge_custody: mergeCustody };
    },
  };
}

export interface AcpProjectControlDomainDeps {
  /** Apply drain or stop to the Project this connection bound, as asked. */
  mutate: (operation: ProjectControlOperation, request: ProjectControlRequest) => Promise<unknown>;
  /** Read the Project's control status, custody included when observable. */
  read: () => Promise<unknown>;
}

/**
 * The `project` domain: drain, stop, and the status projection.
 *
 * Order matters and is pinned by {@link PROJECT_CONTROL_METHODS}: the same
 * array is what `initialize` advertises, so a method bound here and missing
 * there would be a capability a client cannot discover.
 */
export function projectControlMethodDomain(deps: AcpProjectControlDomainDeps): RedskillsAcpMethodDomain {
  return {
    domain: "project",
    bindings: [
      redskillsAcpMethod(PROJECT_CONTROL_METHODS[0], projectControlRequest, ({ params }) =>
        deps.mutate("drain", params)),
      redskillsAcpMethod(PROJECT_CONTROL_METHODS[1], projectControlRequest, ({ params }) =>
        deps.mutate("stop", params)),
      redskillsAcpMethod(PROJECT_CONTROL_METHODS[2], acpNoParams, () => deps.read()),
    ],
    capability: { projectControl: { version: 1, methods: PROJECT_CONTROL_METHODS } },
  };
}
