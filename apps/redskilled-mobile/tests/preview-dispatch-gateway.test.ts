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
