/**
 * The land-verdict vocabulary (Ticket #4138, ADR 0154).
 *
 * The reason this lives in the shared layer at all is that five entry points in
 * four layers must refuse the SAME way; so what is worth testing here is not
 * the switch statement but the properties that make one vocabulary one
 * vocabulary — every reason gets a distinct, actionable sentence, and every
 * refusal names the subject it refused.
 */
import { describe, expect, it } from "vitest";
import {
  LAND_REFUSAL_REASONS,
  allowLand,
  describeLandSubject,
  isLandRefusalReason,
  landRefusalMessage,
  refuseLand,
  type LandSubject,
} from "./land-verdict.js";

const HEAD: LandSubject = { kind: "head", headSha: "abcdef0123456789" };
const PR: LandSubject = { kind: "pull-request", pr: 4138 };

describe("land-verdict vocabulary", () => {
  it("names a subject the way a refusal has to read", () => {
    expect(describeLandSubject(HEAD)).toBe("head abcdef012345");
    expect(describeLandSubject(PR)).toBe("pull request 4138");
  });

  it("gives every reason its own sentence — no two repairs share a message", () => {
    const messages = LAND_REFUSAL_REASONS.map((reason) => landRefusalMessage(reason, HEAD));
    expect(new Set(messages).size).toBe(LAND_REFUSAL_REASONS.length);
    for (const message of messages) {
      expect(message).toContain("head abcdef012345");
      expect(message.length).toBeGreaterThan(60);
    }
  });

  it("carries the caller's detail into the sentence when there is one", () => {
    expect(landRefusalMessage("verifier-failed", PR, "the fix is untested")).toContain(
      "(the fix is untested)",
    );
    expect(landRefusalMessage("verifier-failed", PR, "   ")).not.toContain("()");
  });

  it("builds a refusal on that one sentence, never on a second spelling", () => {
    const decision = refuseLand("no-verdict", PR, "empty ledger");
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("no-verdict");
    expect(decision.message).toBe(landRefusalMessage("no-verdict", PR, "empty ledger"));
  });

  it("builds an authorization that says how it matched and who signed", () => {
    const decision = allowLand("patch-id", "test-verified", "codex:gpt-5");
    expect(decision).toEqual({
      allowed: true,
      matchedBy: "patch-id",
      verdict: "test-verified",
      identity: "codex:gpt-5",
    });
  });

  it("recognises only the closed list of reasons", () => {
    for (const reason of LAND_REFUSAL_REASONS) expect(isLandRefusalReason(reason)).toBe(true);
    expect(isLandRefusalReason("probably-fine")).toBe(false);
    expect(isLandRefusalReason(undefined)).toBe(false);
  });

  it("has no 'unknown' or 'skip' outcome — an absence of judgement is a refusal", () => {
    expect(LAND_REFUSAL_REASONS).not.toContain("unknown");
    expect(LAND_REFUSAL_REASONS).not.toContain("skip");
  });
});
