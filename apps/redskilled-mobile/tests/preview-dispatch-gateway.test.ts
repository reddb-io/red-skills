import { describe, expect, it } from "vitest";

import { createPreviewDispatchGateway } from "../src/transport/preview-dispatch-gateway";

describe("preview dispatch gateway", () => {
  it("keeps the Issue identity attached to the preview Worker", async () => {
    const gateway = createPreviewDispatchGateway(true);

    await expect(
      gateway.dispatch({
        hostId: "host-1",
        issueUrl: "https://github.com/reddb-io/red-skills/issues/42",
      }),
    ).resolves.toEqual({
      version: 1,
      hostId: "host-1",
      repository: "reddb-io/red-skills",
      ticket: 42,
      workerId: "preview:W42",
      sessionId: "preview-session-42",
    });
  });

  it("serves the dispatched Worker back through the same v2-shaped snapshot", async () => {
    const gateway = createPreviewDispatchGateway(true);
    await gateway.dispatch({
      hostId: "host-1",
      issueUrl: "https://github.com/reddb-io/red-skills/issues/42",
    });

    const snapshot = await gateway.state();
    expect(snapshot.workers).toHaveLength(1);
    expect(snapshot.workers[0]).toMatchObject({
      workerId: "preview:W42",
      phase: "coding",
      heartbeatAgeMs: 3_000,
    });
    expect(snapshot.staleness).toEqual({ stale: false, ageMs: 3_000, reason: "preview snapshot" });

    await expect(gateway.stop("preview:W42")).resolves.toBe(true);
    await expect(gateway.state()).resolves.toMatchObject({ workers: [] });
  });

  it("cannot become a production transport", async () => {
    const gateway = createPreviewDispatchGateway(false);

    await expect(
      gateway.dispatch({
        hostId: "host-1",
        issueUrl: "https://github.com/reddb-io/red-skills/issues/42",
      }),
    ).rejects.toThrow("Remote link is not configured yet");
  });
});
