import { describe, expect, it } from "vitest";
import {
  isAuthorTrusted,
  isTriageDecision,
  planTriageTransition,
  routeNeedsTriage,
  TRIAGE_DECISIONS,
} from "../src/core/auto-triage.js";
import type { TrustPolicy } from "../src/core/trust-gate.js";

// auto-triage is the PURE trust-gated triage router (#751). It decides, over the
// author's trust + a maintainer-summon flag, whether a `needs-triage` issue may
// auto-triage now or must be HELD; and maps each `/triage` decision to its
// canonical label transition.

const strict: TrustPolicy = { enabled: true, allowlist: ["alice", "bob"] };
const permissive: TrustPolicy = { enabled: false, allowlist: [] };

describe("planTriageTransition — canonical transitions", () => {
  it("ready-for-agent strips needs-triage, adds ready-for-agent, stays open", () => {
    expect(planTriageTransition("ready-for-agent")).toEqual({
      remove: ["needs-triage"],
      add: ["ready-for-agent"],
      close: false,
    });
  });

  it("needs-info strips needs-triage, adds needs-info, stays open", () => {
    expect(planTriageTransition("needs-info")).toEqual({
      remove: ["needs-triage"],
      add: ["needs-info"],
      close: false,
    });
  });

  it("ready-for-human strips needs-triage, adds ready-for-human, stays open", () => {
    expect(planTriageTransition("ready-for-human")).toEqual({
      remove: ["needs-triage"],
      add: ["ready-for-human"],
      close: false,
    });
  });

  it("wontfix strips needs-triage, adds wontfix, and CLOSES", () => {
    expect(planTriageTransition("wontfix")).toEqual({
      remove: ["needs-triage"],
      add: ["wontfix"],
      close: true,
    });
  });

  it("every decision is a single-state transition that always sheds needs-triage", () => {
    for (const d of TRIAGE_DECISIONS) {
      const t = planTriageTransition(d);
      expect(t.remove).toEqual(["needs-triage"]);
      expect(t.add).toHaveLength(1);
    }
  });
});

describe("isTriageDecision", () => {
  it("accepts the four canonical decisions and rejects anything else", () => {
    for (const d of TRIAGE_DECISIONS) expect(isTriageDecision(d)).toBe(true);
    expect(isTriageDecision("running")).toBe(false);
    expect(isTriageDecision("")).toBe(false);
    expect(isTriageDecision("ready")).toBe(false);
  });
});

describe("isAuthorTrusted", () => {
  it("is permissive (always trusted) when no allowlist is configured", () => {
    expect(isAuthorTrusted(permissive, "stranger")).toBe(true);
    expect(isAuthorTrusted(permissive, undefined)).toBe(true);
  });

  it("trusts only allowlisted authors in strict mode", () => {
    expect(isAuthorTrusted(strict, "alice")).toBe(true);
    expect(isAuthorTrusted(strict, "stranger")).toBe(false);
  });

  it("treats an unknown author (gh read failed) as untrusted in strict mode", () => {
    expect(isAuthorTrusted(strict, undefined)).toBe(false);
    expect(isAuthorTrusted(strict, "   ")).toBe(false);
  });
});

describe("routeNeedsTriage — the trust gate", () => {
  it("auto-triages everything under a permissive policy", () => {
    expect(routeNeedsTriage(permissive, { authorTrusted: false, summoned: false })).toBe("auto-triage");
  });

  it("auto-triages a trusted author with no summon", () => {
    expect(routeNeedsTriage(strict, { authorTrusted: true, summoned: false })).toBe("auto-triage");
  });

  it("HOLDS an untrusted author with no summon", () => {
    expect(routeNeedsTriage(strict, { authorTrusted: false, summoned: false })).toBe("hold-for-summon");
  });

  it("a maintainer summon releases an untrusted author's issue", () => {
    expect(routeNeedsTriage(strict, { authorTrusted: false, summoned: true })).toBe("auto-triage");
  });
});
