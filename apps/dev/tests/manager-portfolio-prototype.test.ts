import { describe, expect, it } from "vitest";
import {
  applyManagerAction,
  createPrototypePortfolio,
  exportCheckpoint,
  importCheckpoint,
  type ManagerActor,
} from "../src/prototypes/manager-portfolio-machine.js";

type Portfolio = ReturnType<typeof createPrototypePortfolio>;

function effortGeneration(
  state: Portfolio,
  effortId = "effort-alpha",
): number {
  return state.efforts[effortId]!.generation;
}

function actor(
  state: Portfolio,
  sessionId: string,
  leaseToken: string | null = null,
  hostId = state.authority.hostId,
  authorityEpoch = state.authority.epoch,
): ManagerActor {
  return { hostId, sessionId, authorityEpoch, leaseToken };
}

function leaseActor(
  state: Portfolio,
  sessionId: string,
  effortId = "effort-alpha",
): ManagerActor {
  return actor(state, sessionId, state.efforts[effortId]!.lease!.token);
}

describe("Manager portfolio transition prototype", () => {
  it("leases efforts independently but rejects a second writer for the same effort", () => {
    let state = createPrototypePortfolio();

    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-beta",
      actor: actor(state, "session-b"),
      expectedGeneration: effortGeneration(state, "effort-beta"),
    });

    expect(state.efforts["effort-alpha"]!.lease?.sessionId).toBe("session-a");
    expect(state.efforts["effort-beta"]!.lease?.sessionId).toBe("session-b");

    const rejected = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-b"),
      expectedGeneration: effortGeneration(state),
    });

    expect(rejected.efforts).toBe(state.efforts);
    expect(rejected.portfolioGeneration).toBe(state.portfolioGeneration);
    expect(rejected.lastResult).toMatchObject({ kind: "rejected", code: "lease-held" });
  });

  it("rejects a stale generation instead of overwriting a newer transition", () => {
    let state = createPrototypePortfolio();
    const staleGeneration = effortGeneration(state);
    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-a"),
      expectedGeneration: staleGeneration,
    });

    const rejected = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-red",
      outcome: "published",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: staleGeneration,
    });

    expect(rejected.efforts).toBe(state.efforts);
    expect(rejected.portfolioGeneration).toBe(state.portfolioGeneration);
    expect(rejected.lastResult).toMatchObject({ kind: "rejected", code: "generation-conflict" });
    expect(rejected.efforts["effort-alpha"]!.projections["repo-red"]!.status).toBe("unpublished");
  });

  it("end pauses and releases the lease without cancelling published owner work", () => {
    let state = createPrototypePortfolio();
    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    state = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-red",
      outcome: "published",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    state = applyManagerAction(state, {
      type: "end",
      effortId: "effort-alpha",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });

    expect(state.efforts["effort-alpha"]).toMatchObject({ lifecycle: "paused", lease: null });
    expect(state.efforts["effort-alpha"]!.projections["repo-red"]).toMatchObject({
      status: "published",
      ownerWork: "continues",
    });

    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-b"),
      expectedGeneration: effortGeneration(state),
    });
    expect(state.efforts["effort-alpha"]).toMatchObject({ lifecycle: "active" });
    expect(state.efforts["effort-alpha"]!.lease?.sessionId).toBe("session-b");
  });

  it("leaves a durable lease after a crash and recovers it only from a crashed session", () => {
    let state = createPrototypePortfolio();
    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    state = applyManagerAction(state, {
      type: "crash-session",
      actor: leaseActor(state, "session-a"),
    });

    expect(state.efforts["effort-alpha"]!.lease?.sessionId).toBe("session-a");
    expect(state.sessions["host-a/session-a"]).toBe("crashed");

    const abandonedToken = state.efforts["effort-alpha"]!.lease!.token;
    state = applyManagerAction(state, {
      type: "recover-lease",
      effortId: "effort-alpha",
      actor: actor(state, "recovery-session"),
      expectedGeneration: effortGeneration(state),
    });

    expect(state.efforts["effort-alpha"]!.lease?.sessionId).toBe("recovery-session");
    expect(state.lastResult).toMatchObject({ kind: "applied", code: "lease-recovered" });

    const staleWriter = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-red",
      outcome: "published",
      actor: actor(state, "recovery-session", abandonedToken),
      expectedGeneration: effortGeneration(state),
    });
    expect(staleWriter.lastResult).toMatchObject({
      kind: "rejected",
      code: "lease-token-conflict",
    });

    state = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-red",
      outcome: "published",
      actor: leaseActor(state, "recovery-session"),
      expectedGeneration: effortGeneration(state),
    });
    expect(state.lastResult).toMatchObject({ kind: "applied", code: "map-published" });
  });

  it("transfers write authority on checkpoint import and invalidates source leases", () => {
    let source = createPrototypePortfolio();
    source = applyManagerAction(source, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(source, "session-a"),
      expectedGeneration: effortGeneration(source),
    });
    const checkpoint = exportCheckpoint(source);
    const transfer = importCheckpoint(source, checkpoint, "host-b");
    source = transfer.source;
    const imported = transfer.destination;

    expect(imported.authority).toEqual({ hostId: "host-b", epoch: 2 });
    expect(imported.efforts["effort-alpha"]!.lease).toBeNull();

    const rejected = applyManagerAction(source, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(source, "session-a", null, "host-a", 1),
      expectedGeneration: effortGeneration(source),
    });
    expect(rejected.efforts).toBe(source.efforts);
    expect(rejected.portfolioGeneration).toBe(source.portfolioGeneration);
    expect(rejected.lastResult).toMatchObject({ kind: "rejected", code: "not-authority" });

    const resumed = applyManagerAction(imported, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(imported, "session-b"),
      expectedGeneration: effortGeneration(imported),
    });
    expect(resumed.efforts["effort-alpha"]!.lease?.sessionId).toBe("session-b");
  });

  it("fences a stale same-host writer after checkpoint authority advances", () => {
    const original = createPrototypePortfolio();
    const checkpoint = exportCheckpoint(original);
    const transfer = importCheckpoint(original, checkpoint, "host-a");

    const rejected = applyManagerAction(transfer.source, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(transfer.source, "reused-session", null, "host-a", 1),
      expectedGeneration: effortGeneration(transfer.source),
    });

    expect(transfer.source.authority).toEqual({ hostId: "host-a", epoch: 2 });
    expect(rejected.lastResult).toMatchObject({
      kind: "rejected",
      code: "authority-epoch-conflict",
    });
  });

  it("keeps partial publication explicit and retries idempotently", () => {
    let state = createPrototypePortfolio();
    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    state = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-red",
      outcome: "published",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    state = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-blue",
      outcome: "failed",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });

    expect(state.efforts["effort-alpha"]!.projections).toMatchObject({
      "repo-red": { status: "published", attempts: 1 },
      "repo-blue": { status: "failed", attempts: 1 },
    });

    state = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-blue",
      outcome: "published",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    const afterRetry = state;
    state = applyManagerAction(state, {
      type: "publish-map",
      effortId: "effort-alpha",
      repository: "repo-blue",
      outcome: "published",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });

    expect(afterRetry.efforts["effort-alpha"]!.projections["repo-blue"]).toMatchObject({
      status: "published",
      mapRef: "repo-blue#manager-map-effort-alpha",
      attempts: 2,
    });
    expect(state.efforts).toBe(afterRetry.efforts);
    expect(state.portfolioGeneration).toBe(afterRetry.portfolioGeneration);
    expect(state.lastResult).toMatchObject({ kind: "applied", code: "map-already-published" });
  });

  it("refuses completion while a repository projection is missing", () => {
    let state = createPrototypePortfolio();
    state = applyManagerAction(state, {
      type: "resume",
      effortId: "effort-alpha",
      actor: actor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });
    const rejected = applyManagerAction(state, {
      type: "complete",
      effortId: "effort-alpha",
      actor: leaseActor(state, "session-a"),
      expectedGeneration: effortGeneration(state),
    });

    expect(rejected.efforts).toBe(state.efforts);
    expect(rejected.portfolioGeneration).toBe(state.portfolioGeneration);
    expect(rejected.lastResult).toMatchObject({ kind: "rejected", code: "publication-incomplete" });
  });
});
