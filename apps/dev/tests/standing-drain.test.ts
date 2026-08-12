import { describe, expect, it, vi } from "vitest";
import { maintainStandingDrain } from "../src/runtime/standing-drain.js";

function harness(input: {
  standing?: { runner: "codex"; target: number } | null;
  held?: object | null;
} = {}) {
  const register = vi.fn(async () => undefined);
  const renew = vi.fn(async () => "renewed");
  return {
    register,
    renew,
    deps: {
      standing: () => input.standing ?? null,
      registration: async () => input.held ?? null,
      register,
      renew,
    },
  };
}

describe("standing drain maintenance", () => {
  it("keeps an undeclared project explicit-only", async () => {
    const { deps, register, renew } = harness();

    await expect(maintainStandingDrain(deps)).resolves.toBe("renewed");

    expect(register).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalledOnce();
  });

  it("registers a declared drain when an MCP session starts without one", async () => {
    const { deps, register, renew } = harness({
      standing: { runner: "codex", target: 4 },
    });

    await expect(maintainStandingDrain(deps)).resolves.toBe("renewed");

    expect(register).toHaveBeenCalledWith({ runner: "codex", target: 4 });
    expect(renew).toHaveBeenCalledOnce();
  });

  it("renews an existing registration across an MCP session swap", async () => {
    const { deps, register, renew } = harness({
      standing: { runner: "codex", target: 4 },
      held: { project_label: "acme/widgets" },
    });

    await maintainStandingDrain(deps);

    expect(register).not.toHaveBeenCalled();
    expect(renew).toHaveBeenCalledOnce();
  });
});
