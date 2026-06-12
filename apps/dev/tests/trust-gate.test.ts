import { describe, expect, it } from "vitest";
import {
  parseTrustPolicy,
  evaluateTrustGate,
  planTrustStrip,
  TRUST_ALLOWLIST_KEY,
  type TrustPolicy,
  type TrustProvenance,
} from "../src/core/trust-gate.js";
import type { ConfigValues } from "../src/core/config.js";

// trust-gate is the PURE "executable issue" predicate (ADR 0056, #621). The
// acceptance criterion is an exhaustive matrix over
//   author (trusted / untrusted)
//     × label-actor (allowlisted / non-allowlisted / automation)
//       × config (present / absent).

const ALLOW = ["alice", "bob"];
const policy: TrustPolicy = { enabled: true, allowlist: ALLOW };
const permissive: TrustPolicy = { enabled: false, allowlist: [] };

function prov(author?: string, actor?: string): TrustProvenance {
  return { author, readyForAgentActor: actor };
}

describe("parseTrustPolicy", () => {
  it("is permissive (disabled) when the allowlist key is absent", () => {
    const p = parseTrustPolicy({} as ConfigValues);
    expect(p.enabled).toBe(false);
    expect(p.allowlist).toEqual([]);
  });

  it("is permissive when the allowlist value is empty/whitespace", () => {
    expect(parseTrustPolicy({ [TRUST_ALLOWLIST_KEY]: "   " }).enabled).toBe(false);
  });

  it("parses a comma-separated allowlist into a trimmed, @-stripped, de-duped set", () => {
    const p = parseTrustPolicy({ [TRUST_ALLOWLIST_KEY]: " alice, @bob ,alice,  " });
    expect(p.enabled).toBe(true);
    expect(p.allowlist).toEqual(["alice", "bob"]);
  });

  it("accepts whitespace/newline separators too", () => {
    const p = parseTrustPolicy({ [TRUST_ALLOWLIST_KEY]: "alice\nbob carol" });
    expect(p.allowlist).toEqual(["alice", "bob", "carol"]);
  });
});

describe("evaluateTrustGate — absent config (permissive)", () => {
  it("executes everything, even an unknown author + unknown actor", () => {
    expect(evaluateTrustGate(permissive, prov(undefined, undefined)).executable).toBe(true);
    expect(evaluateTrustGate(permissive, prov("stranger", "github-actions[bot]")).executable).toBe(true);
  });
});

describe("evaluateTrustGate — strict mode matrix", () => {
  it("trusted author + allowlisted actor → executable", () => {
    expect(evaluateTrustGate(policy, prov("alice", "bob")).executable).toBe(true);
  });

  it("untrusted author + allowlisted actor → blocked (on the author)", () => {
    const v = evaluateTrustGate(policy, prov("stranger", "alice"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("untrusted author 'stranger'");
  });

  it("trusted author + non-allowlisted actor → blocked (on the actor)", () => {
    const v = evaluateTrustGate(policy, prov("alice", "stranger"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("applied by 'stranger'");
  });

  it("trusted author + AUTOMATION actor (bot, not in allowlist) → blocked", () => {
    const v = evaluateTrustGate(policy, prov("alice", "github-actions[bot]"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("github-actions[bot]");
  });

  it("untrusted author + non-allowlisted actor → blocked (author reported first)", () => {
    const v = evaluateTrustGate(policy, prov("stranger", "intruder"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("untrusted author");
  });

  it("unknown author (gh read failed) → blocked", () => {
    const v = evaluateTrustGate(policy, prov(undefined, "alice"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("(unknown)");
  });

  it("trusted author + unknown actor (no labeled event found) → blocked", () => {
    const v = evaluateTrustGate(policy, prov("alice", undefined));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("unknown actor");
  });
});

describe("planTrustStrip", () => {
  it("is a no-op under a permissive policy (no allowlist → strips nothing)", () => {
    const plans = planTrustStrip(permissive, [{ number: 1, provenance: prov("stranger", "bot") }]);
    expect(plans).toEqual([]);
  });

  it("strips only the non-executable candidates and emits an audit comment", () => {
    const plans = planTrustStrip(policy, [
      { number: 10, provenance: prov("alice", "bob") }, // executable → kept
      { number: 11, provenance: prov("stranger", "bob") }, // untrusted author → strip
      { number: 12, provenance: prov("alice", "github-actions[bot]") }, // bot actor → strip
    ]);
    expect(plans.map((p) => p.number)).toEqual([11, 12]);
    expect(plans[0]!.comment).toContain("stripped `ready-for-agent`");
    expect(plans[0]!.comment).toContain("Re-author");
    expect(plans[0]!.comment).toContain("untrusted author 'stranger'");
  });
});
