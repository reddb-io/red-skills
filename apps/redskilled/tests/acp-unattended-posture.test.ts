import { describe, expect, it } from "vitest";

import { ACP_AGENT_IDS } from "@reddb-io/protocol-acp";
import {
  ACP_UNATTENDED_POSTURES,
  unattendedLaunchArgs,
  unattendedPostureFor,
  unattendedSessionMode,
} from "../src/acp-unattended-posture.js";

/**
 * The posture declaration itself (#4278).
 *
 * The conformance matrix pins WHICH posture each Agent has; this pins that the
 * three readers agree on what a posture MEANS — a launch-args posture must not
 * also look like a session-mode one, and a `none-needed` Agent must produce
 * neither, or an Agent that needs nothing would still be launched with something.
 */
describe("the declared unattended posture", () => {
  it("answers for every Agent the wire knows, and for no other", () => {
    expect(Object.keys(ACP_UNATTENDED_POSTURES).sort()).toEqual([...ACP_AGENT_IDS].sort());
    for (const agent of ACP_AGENT_IDS) {
      expect(unattendedPostureFor(agent)).toBe(ACP_UNATTENDED_POSTURES[agent]);
    }
  });

  it("reads a launch-args posture as arguments and nothing else", () => {
    const posture = unattendedPostureFor("codex");
    expect(unattendedLaunchArgs(posture)).toEqual([
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=danger-full-access",
    ]);
    expect(unattendedSessionMode(posture)).toBeUndefined();
  });

  it("reads a session-mode posture as a mode and nothing else", () => {
    const posture = unattendedPostureFor("claude-code");
    expect(unattendedSessionMode(posture)).toBe("bypassPermissions");
    expect(unattendedLaunchArgs(posture)).toEqual([]);
  });

  it("launches a none-needed Agent with nothing added", () => {
    for (const agent of ["redcode", "pi", "opencode"] as const) {
      const posture = unattendedPostureFor(agent);
      expect(posture.kind).toBe("none-needed");
      expect(unattendedLaunchArgs(posture)).toEqual([]);
      expect(unattendedSessionMode(posture)).toBeUndefined();
    }
  });
});
