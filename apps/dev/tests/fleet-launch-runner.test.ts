// fleet-launch-runner.test.ts — the launch runner cascade (#2545).
//
// A fresh `fleet N` launch must honor, in order: the explicit --runner flag,
// the operator's RED_AFK_RUNNER env AT THIS LAUNCH, and only then the
// registered profile. The 2026-07-23 trap: kill the codex fleet, relaunch with
// RED_AFK_RUNNER=claude, and the supervisor resumed codex from the stale
// fleets.toonl profile because the profile was fed to detectRunner as the flag.

import { describe, expect, it } from "vitest";
import { resolveLaunchRunnerPin } from "../src/commands/fleet.js";

describe("resolveLaunchRunnerPin (#2545)", () => {
  it("explicit flag wins over everything", () => {
    expect(resolveLaunchRunnerPin("codex", { RED_AFK_RUNNER: "claude" }, "opencode")).toBe("codex");
  });

  it("the operator's RED_AFK_RUNNER env beats the stale registered profile", () => {
    expect(resolveLaunchRunnerPin(undefined, { RED_AFK_RUNNER: "claude" }, "codex")).toBe("claude");
  });

  it("the registered profile applies when neither flag nor env pin a runner", () => {
    expect(resolveLaunchRunnerPin(undefined, {}, "codex")).toBe("codex");
  });

  it("an invalid RED_AFK_RUNNER value errors loudly instead of silently resuming the profile", () => {
    expect(() => resolveLaunchRunnerPin(undefined, { RED_AFK_RUNNER: "gpt" }, "codex")).toThrow(
      "unsupported runner",
    );
  });

  it("nothing pinned → undefined (ambient detection decides)", () => {
    expect(resolveLaunchRunnerPin(undefined, {}, undefined)).toBeUndefined();
  });
});
