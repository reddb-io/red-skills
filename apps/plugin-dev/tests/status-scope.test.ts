// `status` declares worker | project | host and used to answer PROJECT status
// for every one of them — the same healthy-looking-wrong-answer class #4113
// was raised about, still live after the refusal fix. The host scope has been
// fillable all along (`_redskills/host_state` is served); the worker scope
// refuses by name until a method serves it, because a scope silently
// substituted is worse than one refused.
import { describe, expect, it, vi } from "vitest";

import { invokeProjectMcp } from "../src/project-acp-adapter.js";
import type { RedskillsProjectAcpSession } from "@reddb-io/redskilled/acp-client";

function session() {
  const control = vi.fn(async () => ({ version: 1, project_id: "github:1" }));
  const hostState = vi.fn(async () => ({ workers: [], daemon_version: "9.9.9" }));
  return {
    spy: { control, hostState },
    client: { control, hostState } as never as RedskillsProjectAcpSession,
  };
}

describe("status honors its scope", () => {
  it("scope host reaches the daemon's host_state, not the project control surface", async () => {
    const { spy, client } = session();

    const answer = await invokeProjectMcp(client, "status", { scope: "host" });

    expect(spy.hostState).toHaveBeenCalledOnce();
    expect(spy.control).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ daemon_version: "9.9.9" });
  });

  it("scope worker refuses by name instead of silently answering project status", async () => {
    const { spy, client } = session();

    await expect(invokeProjectMcp(client, "status", { scope: "worker" }))
      .rejects.toThrow(/scope "worker" .* is not served|status \{ scope: "worker" \} is not served/);
    expect(spy.control).not.toHaveBeenCalled();
    expect(spy.hostState).not.toHaveBeenCalled();
  });

  it("scope project — and an unstated scope — still reach the control surface", async () => {
    const { spy, client } = session();

    await invokeProjectMcp(client, "status", { scope: "project" });
    await invokeProjectMcp(client, "status", {});

    expect(spy.control).toHaveBeenCalledTimes(2);
    expect(spy.control).toHaveBeenCalledWith("status");
    expect(spy.hostState).not.toHaveBeenCalled();
  });
});
