import { describe, expect, it } from "vitest";
import {
  detectCapabilities,
  dispatchLog,
  selectRunMode,
  type CapabilityProbes,
} from "../src/core/capabilities.js";

// Hermetic probe factory — every disk/host decision is a stub, never reads the
// real plugin tree, never spawns claude or codex. Worktree defaults to true so
// the probe is host-independent (mirrors CAPABILITIES_HAS_WORKTREE=1).
function probes(overrides: Partial<CapabilityProbes> = {}): CapabilityProbes {
  return {
    nativeAgentsPresent: () => false,
    codexPhasesPresent: () => false,
    worktreeAvailable: () => true,
    ...overrides,
  };
}

describe("detectCapabilities", () => {
  it("claude reports structured/resume/hooks/perm; native gated on disk probe", () => {
    const caps = detectCapabilities({ runner: "claude", probes: probes() });
    expect(caps).toEqual({
      nativeAgents: false,
      structuredOutput: true,
      resumeSession: true,
      worktreeSupport: true,
      hooksEvents: true,
      permissionModes: true,
      phasedMode: false,
    });
  });

  it("claude promotes nativeAgents when the production sub-agent files exist", () => {
    const caps = detectCapabilities({
      runner: "claude",
      probes: probes({ nativeAgentsPresent: () => true }),
    });
    expect(caps.nativeAgents).toBe(true);
  });

  it("codex reports structured/hooks/perm, resume=false, phased gated on disk", () => {
    const caps = detectCapabilities({ runner: "codex", probes: probes() });
    expect(caps).toEqual({
      nativeAgents: false,
      structuredOutput: true,
      resumeSession: false,
      worktreeSupport: true,
      hooksEvents: true,
      permissionModes: true,
      phasedMode: false,
    });
  });

  it("codex promotes phasedMode when the inline-phase prompts exist", () => {
    const caps = detectCapabilities({
      runner: "codex",
      probes: probes({ codexPhasesPresent: () => true }),
    });
    expect(caps.phasedMode).toBe(true);
  });

  it("unknown runner assumes nothing; structuredOutput honours RED_AFK_RUNNER_HAS_JSON", () => {
    const bare = detectCapabilities({ runner: "hermes", probes: probes() });
    expect(bare).toEqual({
      nativeAgents: false,
      structuredOutput: false,
      resumeSession: false,
      worktreeSupport: true,
      hooksEvents: false,
      permissionModes: false,
      phasedMode: false,
    });

    const opted = detectCapabilities({ runner: "hermes", probes: probes(), runnerHasJson: true });
    expect(opted.structuredOutput).toBe(true);
  });

  it("worktreeSupport tracks the host probe", () => {
    const caps = detectCapabilities({
      runner: "claude",
      probes: probes({ worktreeAvailable: () => false }),
    });
    expect(caps.worktreeSupport).toBe(false);
  });
});

describe("selectRunMode — auto selection", () => {
  it("claude → claude-basic when no native agents", () => {
    expect(
      selectRunMode({ runner: "claude", capabilities: { nativeAgents: false, phasedMode: false } }),
    ).toBe("claude-basic");
  });

  it("claude → claude-native when 3 agents present", () => {
    expect(
      selectRunMode({ runner: "claude", capabilities: { nativeAgents: true, phasedMode: false } }),
    ).toBe("claude-native");
  });

  it("claude → claude-basic when one agent missing (degradation)", () => {
    // A half-native set leaves nativeAgents=false via the disk probe, so the
    // selector silently falls back to basic.
    const caps = detectCapabilities({
      runner: "claude",
      probes: probes({ nativeAgentsPresent: () => false }),
    });
    expect(selectRunMode({ runner: "claude", capabilities: caps })).toBe("claude-basic");
  });

  it("codex → codex-basic when no phase prompts", () => {
    expect(
      selectRunMode({ runner: "codex", capabilities: { nativeAgents: false, phasedMode: false } }),
    ).toBe("codex-basic");
  });

  it("codex → codex-phased when phase prompts shipped", () => {
    expect(
      selectRunMode({ runner: "codex", capabilities: { nativeAgents: false, phasedMode: true } }),
    ).toBe("codex-phased");
  });

  it("codex → codex-basic when one phase prompt missing (degradation)", () => {
    const caps = detectCapabilities({
      runner: "codex",
      probes: probes({ codexPhasesPresent: () => false }),
    });
    expect(selectRunMode({ runner: "codex", capabilities: caps })).toBe("codex-basic");
  });

  it("unknown runner → hermes-fallback regardless of probes", () => {
    expect(
      selectRunMode({ runner: "hermes", capabilities: { nativeAgents: true, phasedMode: true } }),
    ).toBe("hermes-fallback");
  });
});

describe("selectRunMode — operator overrides", () => {
  const claudeNative = { nativeAgents: true, phasedMode: false };
  const codexBasic = { nativeAgents: false, phasedMode: false };

  it("basic forces claude-basic even when native artefacts exist", () => {
    expect(selectRunMode({ runner: "claude", capabilities: claudeNative, override: "basic" })).toBe(
      "claude-basic",
    );
  });

  it("basic forces codex-basic", () => {
    expect(
      selectRunMode({
        runner: "codex",
        capabilities: { nativeAgents: false, phasedMode: true },
        override: "basic",
      }),
    ).toBe("codex-basic");
  });

  it("basic on an unknown runner forces hermes-fallback", () => {
    expect(selectRunMode({ runner: "hermes", capabilities: codexBasic, override: "basic" })).toBe(
      "hermes-fallback",
    );
  });

  it("fallback forces hermes-fallback unconditionally", () => {
    expect(
      selectRunMode({ runner: "claude", capabilities: claudeNative, override: "fallback" }),
    ).toBe("hermes-fallback");
  });

  it("native promotes when the env can satisfy it", () => {
    expect(selectRunMode({ runner: "claude", capabilities: claudeNative, override: "native" })).toBe(
      "claude-native",
    );
  });

  it("native is ignored on codex → auto kicks in", () => {
    expect(selectRunMode({ runner: "codex", capabilities: codexBasic, override: "native" })).toBe(
      "codex-basic",
    );
  });

  it("native is ignored when claude lacks the agents → falls back to claude-basic", () => {
    expect(selectRunMode({ runner: "claude", capabilities: codexBasic, override: "native" })).toBe(
      "claude-basic",
    );
  });

  it("phased promotes codex when the env can satisfy it", () => {
    expect(
      selectRunMode({
        runner: "codex",
        capabilities: { nativeAgents: false, phasedMode: true },
        override: "phased",
      }),
    ).toBe("codex-phased");
  });

  it("phased is ignored when codex lacks phase prompts → falls back to codex-basic", () => {
    expect(selectRunMode({ runner: "codex", capabilities: codexBasic, override: "phased" })).toBe(
      "codex-basic",
    );
  });

  it("phased is ignored on claude → auto kicks in", () => {
    expect(selectRunMode({ runner: "claude", capabilities: claudeNative, override: "phased" })).toBe(
      "claude-native",
    );
  });
});

describe("dispatchLog", () => {
  it("renders one deterministic line with axes in wire order", () => {
    const caps = {
      nativeAgents: false,
      structuredOutput: true,
      resumeSession: true,
      worktreeSupport: true,
      hooksEvents: true,
      permissionModes: true,
      phasedMode: false,
    };
    expect(dispatchLog("claude", "claude-basic", caps)).toBe(
      "dispatch: runner=claude mode=claude-basic native_agents=0 structured_output=1 " +
        "resume_session=1 worktree_support=1 hooks_events=1 permission_modes=1 phased_mode=0",
    );
  });
});
