/**
 * PROTOTYPE — delete or absorb after the Manager storage decisions are settled.
 *
 * Question: can one small, storage-agnostic state machine make Manager's effort
 * lifecycle, effort-scoped leases, optimistic generations, crash recovery,
 * checkpoint authority transfer, and partial cross-repository publication
 * concrete enough to expose disputed transitions before a store is selected?
 *
 * This module is deliberately pure and in-memory. The terminal explorer is a
 * throwaway adapter; this reducer is the portable part under evaluation.
 */

export type ManagerLifecycle = "inbox" | "active" | "paused" | "completed" | "abandoned";
export type ProjectionStatus = "unpublished" | "failed" | "published";

export interface ManagerActor {
  hostId: string;
  sessionId: string;
  authorityEpoch: number;
  leaseToken: string | null;
}

export interface EffortLease {
  sessionId: string;
  token: string;
  acquiredGeneration: number;
}

export interface RepositoryProjection {
  repository: string;
  status: ProjectionStatus;
  attempts: number;
  idempotencyKey: string;
  mapRef: string | null;
  ownerWork: "not-started" | "continues";
  lastFailure: string | null;
}

export interface ManagerEffort {
  id: string;
  name: string;
  destination: string;
  lifecycle: ManagerLifecycle;
  generation: number;
  lease: EffortLease | null;
  unmaterialisedIntent: string[];
  projections: Record<string, RepositoryProjection>;
  lastTransition: string;
}

export interface TransitionResult {
  kind: "applied" | "rejected";
  code: string;
  message: string;
}

export interface ManagerPortfolio {
  prototype: true;
  replicaStatus: "active" | "retired";
  authority: { hostId: string; epoch: number };
  portfolioGeneration: number;
  focusEffortId: string;
  sessions: Record<string, "active" | "crashed">;
  efforts: Record<string, ManagerEffort>;
  lastResult: TransitionResult;
}

export interface ManagerCheckpoint {
  prototype: true;
  sourceAuthority: { hostId: string; epoch: number };
  portfolioGeneration: number;
  focusEffortId: string;
  efforts: Record<string, ManagerEffort>;
}

export interface ManagerCheckpointTransfer {
  source: ManagerPortfolio;
  destination: ManagerPortfolio;
}

type EffortMutation = {
  effortId: string;
  actor: ManagerActor;
  expectedGeneration: number;
};

export type ManagerAction =
  | (EffortMutation & { type: "resume" })
  | (EffortMutation & { type: "end" })
  | (EffortMutation & { type: "complete" })
  | (EffortMutation & { type: "recover-lease" })
  | (EffortMutation & {
      type: "publish-map";
      repository: string;
      outcome: "published" | "failed";
    })
  | { type: "crash-session"; actor: ManagerActor };

const applied = (code: string, message: string): TransitionResult => ({
  kind: "applied",
  code,
  message,
});

const rejected = (code: string, message: string): TransitionResult => ({
  kind: "rejected",
  code,
  message,
});

function projection(repository: string, effortId: string): RepositoryProjection {
  return {
    repository,
    status: "unpublished",
    attempts: 0,
    idempotencyKey: `manager-map/${effortId}/${repository}`,
    mapRef: null,
    ownerWork: "not-started",
    lastFailure: null,
  };
}

function effort(
  id: string,
  name: string,
  destination: string,
  repositories: string[],
): ManagerEffort {
  return {
    id,
    name,
    destination,
    lifecycle: "inbox",
    generation: 0,
    lease: null,
    unmaterialisedIntent: [`Clarify acceptance boundary for ${destination}`],
    projections: Object.fromEntries(repositories.map((repo) => [repo, projection(repo, id)])),
    lastTransition: "created in local inbox",
  };
}

export function createPrototypePortfolio(): ManagerPortfolio {
  return {
    prototype: true,
    replicaStatus: "active",
    authority: { hostId: "host-a", epoch: 1 },
    portfolioGeneration: 0,
    focusEffortId: "effort-alpha",
    sessions: {},
    efforts: {
      "effort-alpha": effort(
        "effort-alpha",
        "Ship cross-repository Manager journey",
        "Acceptance journey delivered in both repositories",
        ["repo-red", "repo-blue"],
      ),
      "effort-beta": effort(
        "effort-beta",
        "Independent documentation effort",
        "Operator guide published",
        ["repo-docs"],
      ),
    },
    lastResult: applied("ready", "Prototype portfolio initialised."),
  };
}

function withResult(state: ManagerPortfolio, result: TransitionResult): ManagerPortfolio {
  return { ...state, lastResult: result };
}

function sessionKey(actor: ManagerActor): string {
  return `${actor.hostId}/${actor.sessionId}`;
}

function replaceEffort(
  state: ManagerPortfolio,
  previous: ManagerEffort,
  patch: Partial<ManagerEffort>,
  result: TransitionResult,
): ManagerPortfolio {
  const nextGeneration = previous.generation + 1;
  return {
    ...state,
    portfolioGeneration: state.portfolioGeneration + 1,
    sessions: { ...state.sessions },
    efforts: {
      ...state.efforts,
      [previous.id]: { ...previous, ...patch, generation: nextGeneration },
    },
    lastResult: result,
  };
}

function guardMutation(
  state: ManagerPortfolio,
  action: EffortMutation,
): { effort: ManagerEffort } | { result: TransitionResult } {
  if (action.actor.hostId !== state.authority.hostId) {
    return {
      result: rejected(
        "not-authority",
        `${action.actor.hostId} is retired; ${state.authority.hostId} owns writer epoch ${state.authority.epoch}.`,
      ),
    };
  }
  if (action.actor.authorityEpoch !== state.authority.epoch) {
    return {
      result: rejected(
        "authority-epoch-conflict",
        `Actor epoch ${action.actor.authorityEpoch} is fenced; durable authority epoch is ${state.authority.epoch}.`,
      ),
    };
  }
  if (state.replicaStatus === "retired") {
    return {
      result: rejected(
        "replica-retired",
        "Checkpoint transfer retired this replica; only the destination replica may mutate.",
      ),
    };
  }
  const current = state.efforts[action.effortId];
  if (!current) {
    return { result: rejected("effort-not-found", `Unknown effort ${action.effortId}.`) };
  }
  if (current.generation !== action.expectedGeneration) {
    return {
      result: rejected(
        "generation-conflict",
        `Expected generation ${action.expectedGeneration}; durable generation is ${current.generation}.`,
      ),
    };
  }
  return { effort: current };
}

function requireLease(
  effortRecord: ManagerEffort,
  actor: ManagerActor,
): TransitionResult | null {
  if (!effortRecord.lease) {
    return rejected("lease-required", `Effort ${effortRecord.id} has no writer lease.`);
  }
  if (effortRecord.lease.sessionId !== actor.sessionId) {
    return rejected(
      "lease-held",
      `Effort ${effortRecord.id} is leased by ${effortRecord.lease.sessionId}.`,
    );
  }
  if (effortRecord.lease.token !== actor.leaseToken) {
    return rejected(
      "lease-token-conflict",
      `The supplied lease token is fenced for effort ${effortRecord.id}.`,
    );
  }
  return null;
}

function applyResume(
  state: ManagerPortfolio,
  effortRecord: ManagerEffort,
  actor: ManagerActor,
): ManagerPortfolio {
  if (effortRecord.lifecycle === "completed" || effortRecord.lifecycle === "abandoned") {
    return withResult(
      state,
      rejected("terminal-effort", `${effortRecord.lifecycle} efforts cannot resume.`),
    );
  }
  if (effortRecord.lease && effortRecord.lease.sessionId !== actor.sessionId) {
    return withResult(
      state,
      rejected("lease-held", `Effort ${effortRecord.id} is leased by ${effortRecord.lease.sessionId}.`),
    );
  }
  if (effortRecord.lease && effortRecord.lease.token !== actor.leaseToken) {
    return withResult(
      state,
      rejected("lease-token-conflict", `The supplied lease token is fenced for effort ${effortRecord.id}.`),
    );
  }
  if (!effortRecord.lease && actor.leaseToken !== null) {
    return withResult(
      state,
      rejected("lease-token-conflict", `The supplied lease token no longer owns effort ${effortRecord.id}.`),
    );
  }
  if (effortRecord.lease?.sessionId === actor.sessionId && effortRecord.lifecycle === "active") {
    return withResult(state, applied("already-active", `${actor.sessionId} already owns the active effort.`));
  }
  const nextGeneration = effortRecord.generation + 1;
  const next = replaceEffort(
    state,
    effortRecord,
    {
      lifecycle: "active",
      lease: {
        sessionId: actor.sessionId,
        token: `${effortRecord.id}/lease/${nextGeneration}`,
        acquiredGeneration: nextGeneration,
      },
      lastTransition: `resumed by ${actor.sessionId}`,
    },
    applied("resumed", `${effortRecord.id} is active under an effort-scoped lease.`),
  );
  next.sessions[sessionKey(actor)] = "active";
  return next;
}

function applyEnd(
  state: ManagerPortfolio,
  effortRecord: ManagerEffort,
  actor: ManagerActor,
): ManagerPortfolio {
  const leaseFailure = requireLease(effortRecord, actor);
  if (leaseFailure) return withResult(state, leaseFailure);
  if (effortRecord.lifecycle !== "active") {
    return withResult(state, rejected("not-active", "Only an active effort can be ended."));
  }
  return replaceEffort(
    state,
    effortRecord,
    {
      lifecycle: "paused",
      lease: null,
      lastTransition: `ended by ${actor.sessionId}; owner work remains independent`,
    },
    applied("paused", `${effortRecord.id} paused; published owner work continues.`),
  );
}

function applyPublish(
  state: ManagerPortfolio,
  effortRecord: ManagerEffort,
  action: Extract<ManagerAction, { type: "publish-map" }>,
): ManagerPortfolio {
  const leaseFailure = requireLease(effortRecord, action.actor);
  if (leaseFailure) return withResult(state, leaseFailure);
  if (effortRecord.lifecycle !== "active") {
    return withResult(state, rejected("not-active", "Map publication requires an active effort."));
  }
  const current = effortRecord.projections[action.repository];
  if (!current) {
    return withResult(
      state,
      rejected("repository-out-of-scope", `${action.repository} is not in the effort boundary.`),
    );
  }
  if (current.status === "published") {
    return withResult(
      state,
      applied("map-already-published", `${current.mapRef} already satisfies the idempotency key.`),
    );
  }
  const published = action.outcome === "published";
  const nextProjection: RepositoryProjection = {
    ...current,
    attempts: current.attempts + 1,
    status: published ? "published" : "failed",
    mapRef: published ? `${action.repository}#manager-map-${effortRecord.id}` : null,
    ownerWork: published ? "continues" : "not-started",
    lastFailure: published ? null : "simulated tracker rejection",
  };
  return replaceEffort(
    state,
    effortRecord,
    {
      projections: { ...effortRecord.projections, [action.repository]: nextProjection },
      lastTransition: published
        ? `published ${action.repository} Manager map`
        : `${action.repository} publication failed after other writes may have succeeded`,
    },
    applied(
      published ? "map-published" : "publication-partial",
      published
        ? `${action.repository} map published with a stable idempotency key.`
        : `${action.repository} failed; successful repository maps remain authoritative.`,
    ),
  );
}

function applyRecovery(
  state: ManagerPortfolio,
  effortRecord: ManagerEffort,
  actor: ManagerActor,
): ManagerPortfolio {
  if (actor.leaseToken !== null) {
    return withResult(
      state,
      rejected("lease-token-conflict", "Lease recovery must acquire a fresh fencing token."),
    );
  }
  if (!effortRecord.lease) {
    return withResult(state, rejected("no-orphaned-lease", "There is no lease to recover."));
  }
  const previousSession = `${actor.hostId}/${effortRecord.lease.sessionId}`;
  if (state.sessions[previousSession] !== "crashed") {
    return withResult(
      state,
      rejected("lease-holder-live", `${effortRecord.lease.sessionId} is not recorded as crashed.`),
    );
  }
  const nextGeneration = effortRecord.generation + 1;
  const next = replaceEffort(
    state,
    effortRecord,
    {
      lease: {
        sessionId: actor.sessionId,
        token: `${effortRecord.id}/recovered-lease/${nextGeneration}`,
        acquiredGeneration: nextGeneration,
      },
      lastTransition: `orphaned lease recovered by ${actor.sessionId}`,
    },
    applied("lease-recovered", `Recovered ${effortRecord.id} after the prior session crashed.`),
  );
  next.sessions[sessionKey(actor)] = "active";
  return next;
}

function applyComplete(
  state: ManagerPortfolio,
  effortRecord: ManagerEffort,
  actor: ManagerActor,
): ManagerPortfolio {
  const leaseFailure = requireLease(effortRecord, actor);
  if (leaseFailure) return withResult(state, leaseFailure);
  const incomplete = Object.values(effortRecord.projections).filter(
    (item) => item.status !== "published",
  );
  if (incomplete.length > 0) {
    return withResult(
      state,
      rejected(
        "publication-incomplete",
        `Cannot complete while ${incomplete.map((item) => item.repository).join(", ")} remain unpublished.`,
      ),
    );
  }
  return replaceEffort(
    state,
    effortRecord,
    { lifecycle: "completed", lease: null, lastTransition: "acceptance journey completed" },
    applied("completed", `${effortRecord.id} reached a terminal disposition.`),
  );
}

export function applyManagerAction(
  state: ManagerPortfolio,
  action: ManagerAction,
): ManagerPortfolio {
  if (action.type === "crash-session") {
    if (action.actor.hostId !== state.authority.hostId) {
      return withResult(state, rejected("not-authority", "Only the active host has this session."));
    }
    if (action.actor.authorityEpoch !== state.authority.epoch) {
      return withResult(
        state,
        rejected(
          "authority-epoch-conflict",
          `Actor epoch ${action.actor.authorityEpoch} is fenced; durable authority epoch is ${state.authority.epoch}.`,
        ),
      );
    }
    if (state.replicaStatus === "retired") {
      return withResult(
        state,
        rejected(
          "replica-retired",
          "Checkpoint transfer retired this replica; only the destination replica may mutate.",
        ),
      );
    }
    return {
      ...state,
      sessions: { ...state.sessions, [sessionKey(action.actor)]: "crashed" },
      lastResult: applied(
        "session-crashed",
        `Volatile session ${action.actor.sessionId} vanished; durable effort leases were not rewritten.`,
      ),
    };
  }

  const guarded = guardMutation(state, action);
  if ("result" in guarded) return withResult(state, guarded.result);

  switch (action.type) {
    case "resume":
      return applyResume(state, guarded.effort, action.actor);
    case "end":
      return applyEnd(state, guarded.effort, action.actor);
    case "publish-map":
      return applyPublish(state, guarded.effort, action);
    case "recover-lease":
      return applyRecovery(state, guarded.effort, action.actor);
    case "complete":
      return applyComplete(state, guarded.effort, action.actor);
  }
}

function cloneEfforts(efforts: Record<string, ManagerEffort>): Record<string, ManagerEffort> {
  return structuredClone(efforts);
}

export function exportCheckpoint(state: ManagerPortfolio): ManagerCheckpoint {
  return {
    prototype: true,
    sourceAuthority: { ...state.authority },
    portfolioGeneration: state.portfolioGeneration,
    focusEffortId: state.focusEffortId,
    efforts: cloneEfforts(state.efforts),
  };
}

export function importCheckpoint(
  source: ManagerPortfolio,
  checkpoint: ManagerCheckpoint,
  destinationHostId: string,
): ManagerCheckpointTransfer {
  const efforts = Object.fromEntries(
    Object.entries(cloneEfforts(checkpoint.efforts)).map(([id, record]) => [
      id,
      {
        ...record,
        generation: record.generation + 1,
        lease: null,
        lastTransition: `checkpoint imported by ${destinationHostId}; prior leases invalidated`,
      },
    ]),
  );
  const authority = { hostId: destinationHostId, epoch: checkpoint.sourceAuthority.epoch + 1 };
  const portfolioGeneration = checkpoint.portfolioGeneration + 1;
  const sourceReplica: ManagerPortfolio = {
    ...source,
    replicaStatus: "retired",
    authority,
    portfolioGeneration,
    focusEffortId: checkpoint.focusEffortId,
    efforts: cloneEfforts(efforts),
    lastResult: applied(
      "checkpoint-source-retired",
      `${source.authority.hostId} retired at authority epoch ${authority.epoch}; its prior credentials are fenced.`,
    ),
  };
  const destination: ManagerPortfolio = {
    prototype: true,
    replicaStatus: "active",
    authority,
    portfolioGeneration,
    focusEffortId: checkpoint.focusEffortId,
    sessions: {},
    efforts: cloneEfforts(efforts),
    lastResult: applied(
      "checkpoint-imported",
      `${destinationHostId} is the sole writer; source leases cannot mutate this generation.`,
    ),
  };
  return { source: sourceReplica, destination };
}
