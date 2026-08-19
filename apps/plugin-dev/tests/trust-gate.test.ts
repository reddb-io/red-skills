import { describe, expect, it } from "vitest";
import {
  parseTrustPolicy,
  evaluateTrustGate,
  evaluateClaimTrust,
  evaluateExternalOriginGate,
  describeTrustPosture,
  planTrustStrip,
  resolveActorTrust,
  TRUST_ALLOWLIST_KEY,
  type TrustPolicy,
  type TrustProvenance,
  type ActorTrustLookup,
  type ActorTrustSignals,
  type ExternalOriginState,
} from "../src/core/trust-gate.js";
import type { ConfigValues } from "../src/core/config.js";

// trust-gate is the PURE "executable issue" predicate (ADR 0085, #621). The
// acceptance criterion is an exhaustive matrix over
//   author (trusted / untrusted)
//     × label-actor (allowlisted / non-allowlisted / automation)
//       × config (present / absent).

const ALLOW = ["alice", "bob"];
const policy: TrustPolicy = { enabled: true, allowlist: ALLOW };
const permissive: TrustPolicy = { enabled: false, allowlist: [] };
// A public repo with no allowlist: the #1101 fail-closed default posture.
const failClosed: TrustPolicy = { enabled: false, allowlist: [], visibility: "public", failClosed: true };

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

describe("parseTrustPolicy — repository-visibility-aware default (#1101)", () => {
  it("no allowlist + PUBLIC repo → fail-closed posture", () => {
    const p = parseTrustPolicy({} as ConfigValues, "public");
    expect(p.enabled).toBe(false);
    expect(p.failClosed).toBe(true);
    expect(p.visibility).toBe("public");
    expect(describeTrustPosture(p)).toBe("fail-closed");
  });

  it("no allowlist + PRIVATE repo → permissive (today's behaviour)", () => {
    const p = parseTrustPolicy({} as ConfigValues, "private");
    expect(p.enabled).toBe(false);
    expect(p.failClosed).toBe(false);
    expect(describeTrustPosture(p)).toBe("permissive");
  });

  it("no allowlist + INTERNAL repo → permissive (only public fails closed)", () => {
    expect(parseTrustPolicy({} as ConfigValues, "internal").failClosed).toBe(false);
  });

  it("no allowlist + UNDETERMINABLE visibility → permissive (unknown ≠ public)", () => {
    const p = parseTrustPolicy({} as ConfigValues, undefined);
    expect(p.failClosed).toBe(false);
    expect(describeTrustPosture(p)).toBe("permissive");
  });

  it("a configured allowlist stays STRICT on a public repo (visibility does not weaken it)", () => {
    const p = parseTrustPolicy({ [TRUST_ALLOWLIST_KEY]: "alice" }, "public");
    expect(p.enabled).toBe(true);
    expect(p.failClosed).toBe(false);
    expect(describeTrustPosture(p)).toBe("strict");
  });

  it("a configured allowlist stays STRICT on a private repo too", () => {
    expect(describeTrustPosture(parseTrustPolicy({ [TRUST_ALLOWLIST_KEY]: "alice" }, "private"))).toBe("strict");
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

describe("resolveActorTrust — layered write-access / CODEOWNERS over the allowlist (#747)", () => {
  // The injected fake `gh`: a recording lookup that returns the signals it is
  // primed with, and asserts it was (or was not) consulted.
  function fakeGh(signals: ActorTrustSignals): { lookup: ActorTrustLookup; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      lookup: async (actor: string) => {
        calls.push(actor);
        return signals;
      },
    };
  }

  it("trusts an actor with write access (dynamic base)", async () => {
    const gh = fakeGh({ hasWriteAccess: true, inCodeowners: false });
    const v = await resolveActorTrust(permissive, "maintainer", gh.lookup);
    expect(v.executable).toBe(true);
    expect(v.basis).toBe("write-access");
    expect(gh.calls).toEqual(["maintainer"]);
  });

  it("trusts an actor in CODEOWNERS even without write access", async () => {
    const gh = fakeGh({ hasWriteAccess: false, inCodeowners: true });
    const v = await resolveActorTrust(permissive, "owner", gh.lookup);
    expect(v.executable).toBe(true);
    expect(v.basis).toBe("codeowners");
  });

  it("trusts an allowlisted actor as an override — without consulting gh", async () => {
    const gh = fakeGh({ hasWriteAccess: false, inCodeowners: false });
    const v = await resolveActorTrust(policy, "alice", gh.lookup);
    expect(v.executable).toBe(true);
    expect(v.basis).toBe("allowlist");
    expect(gh.calls).toEqual([]); // override short-circuits before any gh read
  });

  it("refuses an untrusted actor through the gate's refusal shape", async () => {
    const gh = fakeGh({ hasWriteAccess: false, inCodeowners: false });
    const v = await resolveActorTrust(policy, "stranger", gh.lookup);
    expect(v.executable).toBe(false);
    expect(v.basis).toBeUndefined();
    expect(v.reason).toContain("'stranger'");
    expect(v.reason).toContain("not a repository maintainer");
  });

  it("preserves the permissive default when neither a base signal nor an allowlist is available", async () => {
    // gh resolved nothing (undefined signals) AND no allowlist configured.
    const gh = fakeGh({});
    const v = await resolveActorTrust(permissive, "anyone", gh.lookup);
    expect(v.executable).toBe(true);
    expect(v.basis).toBe("permissive-default");
  });

  it("does NOT fall through to permissive when a base signal IS available but negative", async () => {
    const gh = fakeGh({ hasWriteAccess: false, inCodeowners: false });
    const v = await resolveActorTrust(permissive, "stranger", gh.lookup);
    expect(v.executable).toBe(false);
  });

  it("refuses an unknown actor (gh read failed upstream → empty login)", async () => {
    const gh = fakeGh({ hasWriteAccess: false });
    const v = await resolveActorTrust(policy, undefined, gh.lookup);
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("(unknown)");
    expect(gh.calls).toEqual([]); // no login → no gh read
  });

  it("is the single entry point reused for both comment-author and issue-author actors", async () => {
    const gh = fakeGh({ hasWriteAccess: true });
    const commentAuthor = await resolveActorTrust(permissive, "carol", gh.lookup);
    const issueAuthor = await resolveActorTrust(permissive, "carol", gh.lookup);
    expect(commentAuthor.executable).toBe(true);
    expect(issueAuthor.executable).toBe(true);
  });

  it("SUPPRESSES the permissive default under a fail-closed policy (#1101)", async () => {
    // Same undeterminable-signal case as the permissive test above, but a public
    // repo: the absence of a positive maintainer signal now HOLDS instead of waving through.
    const gh = fakeGh({});
    const v = await resolveActorTrust(failClosed, "anyone", gh.lookup);
    expect(v.executable).toBe(false);
    expect(v.basis).toBeUndefined();
  });

  it("still trusts a maintainer with write access under a fail-closed policy", async () => {
    const gh = fakeGh({ hasWriteAccess: true });
    const v = await resolveActorTrust(failClosed, "maintainer", gh.lookup);
    expect(v.executable).toBe(true);
    expect(v.basis).toBe("write-access");
  });
});

describe("evaluateClaimTrust — visibility-aware claim decision (#1101)", () => {
  // A lookup that trusts a fixed set of maintainer logins (write access), and
  // returns determinable-but-negative signals for everyone else.
  function maintainerLookup(...maintainers: string[]): ActorTrustLookup {
    const set = new Set(maintainers);
    return async (actor: string) => ({ hasWriteAccess: set.has(actor), inCodeowners: false });
  }
  const noLookup: ActorTrustLookup = async () => ({});

  it("STRICT policy defers to the allowlist gate (author + actor allowlisted → executable)", async () => {
    const v = await evaluateClaimTrust(policy, prov("alice", "bob"), noLookup);
    expect(v.executable).toBe(true);
  });

  it("STRICT policy blocks a non-allowlisted author regardless of visibility", async () => {
    const v = await evaluateClaimTrust(policy, prov("stranger", "alice"), noLookup);
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("untrusted author 'stranger'");
  });

  it("PERMISSIVE (private repo, no allowlist) executes everything — never consults gh", async () => {
    const calls: string[] = [];
    const spy: ActorTrustLookup = async (a) => {
      calls.push(a);
      return {};
    };
    const v = await evaluateClaimTrust(permissive, prov("stranger", "intruder"), spy);
    expect(v.executable).toBe(true);
    expect(calls).toEqual([]); // permissive short-circuits before any maintainer lookup
  });

  it("FAIL-CLOSED (public repo) executes when BOTH author and promoter are maintainers", async () => {
    const v = await evaluateClaimTrust(failClosed, prov("maint", "maint2"), maintainerLookup("maint", "maint2"));
    expect(v.executable).toBe(true);
  });

  it("FAIL-CLOSED gives an untrusted author the executable external-approval repair", async () => {
    const v = await evaluateClaimTrust(
      failClosed,
      prov("stranger", "maint"),
      maintainerLookup("maint"),
      undefined,
      2062,
    );
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("untrusted author");
    expect(v.repair).toEqual({
      tool: "gh",
      args: {
        commands: [
          ["issue", "edit", "2062", "--add-label", "origin:external"],
          ["issue", "comment", "2062", "--body", "/approve-external"],
        ],
        required_actor: "maintainer",
      },
      why: "mark the issue as external and record explicit approval from a maintainer with write access",
    });
    expect(v.reason).toContain("origin:external");
    expect(v.reason).toContain("/approve-external");
    expect(v.reason).not.toContain("summon");
  });

  it("FAIL-CLOSED holds an untrusted PROMOTER even when the author is a maintainer", async () => {
    const v = await evaluateClaimTrust(failClosed, prov("maint", "intruder"), maintainerLookup("maint"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("untrusted ready-for-agent promoter");
  });

  it("FAIL-CLOSED honours an allowlist override even with no dynamic signal", async () => {
    // A public repo that ALSO configured an allowlist is strict, not fail-closed —
    // but the allowlist override still trusts a listed login on the fail-closed path
    // when (hypothetically) failClosed were set alongside a list.
    const hybrid: TrustPolicy = { enabled: false, allowlist: ["alice"], visibility: "public", failClosed: true };
    const v = await evaluateClaimTrust(hybrid, prov("alice", "alice"), noLookup);
    expect(v.executable).toBe(true);
  });
});

describe("evaluateExternalOriginGate — origin:external hold (#2603)", () => {
  const ext = (external: boolean, approved: boolean, approver?: string): ExternalOriginState => ({
    external,
    approved,
    approver,
  });

  it("passes a non-external issue through untouched", () => {
    const v = evaluateExternalOriginGate(ext(false, false));
    expect(v.executable).toBe(true);
    expect(v.holdForApproval).toBeUndefined();
  });

  it("passes when no external state is supplied at all", () => {
    expect(evaluateExternalOriginGate(undefined).executable).toBe(true);
  });

  it("HOLDS an unapproved external issue and marks it for approval parking", () => {
    const v = evaluateExternalOriginGate(ext(true, false), 2062);
    expect(v.executable).toBe(false);
    expect(v.holdForApproval).toBe(true);
    expect(v.reason).toContain("origin:external");
    expect(v.reason).toContain("/approve-external");
    expect(v.repair).toMatchObject({
      tool: "gh",
      args: {
        commands: [
          ["issue", "edit", "2062", "--add-label", "origin:external"],
          ["issue", "comment", "2062", "--body", "/approve-external"],
        ],
      },
    });
  });

  it("releases an approved external issue", () => {
    const v = evaluateExternalOriginGate(ext(true, true, "maint"));
    expect(v.executable).toBe(true);
    expect(v.holdForApproval).toBeUndefined();
  });
});

describe("evaluateClaimTrust — external-origin integration (#2603)", () => {
  const noLookup: ActorTrustLookup = async () => ({});
  const maintainerLookup = (...maintainers: string[]): ActorTrustLookup => {
    const set = new Set(maintainers);
    return async (actor: string) => ({ hasWriteAccess: set.has(actor), inCodeowners: false });
  };
  const external = (approved: boolean, approver?: string): ExternalOriginState => ({
    external: true,
    approved,
    approver,
  });

  it("HOLDS an unapproved external issue BEFORE any posture check (permissive repo)", async () => {
    const v = await evaluateClaimTrust(permissive, prov("stranger", "stranger"), noLookup, external(false));
    expect(v.executable).toBe(false);
    expect(v.holdForApproval).toBe(true);
  });

  it("HOLDS an unapproved external issue even when it is somehow allowlisted (strict)", async () => {
    const v = await evaluateClaimTrust(policy, prov("alice", "bob"), noLookup, external(false));
    expect(v.executable).toBe(false);
    expect(v.holdForApproval).toBe(true);
  });

  it("keeps the trust gate held when triage:summon is the only attempted cure", async () => {
    // `triage:summon` is deliberately not an input to this gate: applying that
    // label cannot satisfy either half of the external-approval mechanism.
    const v = await evaluateClaimTrust(
      failClosed,
      prov("stranger", "maint"),
      maintainerLookup("maint"),
      { external: false, approved: false },
      2062,
    );

    expect(v.executable).toBe(false);
    expect(v.repair).toMatchObject({
      tool: "gh",
      args: {
        commands: [
          ["issue", "edit", "2062", "--add-label", "origin:external"],
          ["issue", "comment", "2062", "--body", "/approve-external"],
        ],
      },
    });
    expect(JSON.stringify(v)).not.toContain("triage:summon");
  });

  it("an APPROVED external issue vouches for its untrusted author on the fail-closed path", async () => {
    // author is an external stranger; the maintainer /approve-external vouches, and
    // the promoter is a maintainer → executable.
    const v = await evaluateClaimTrust(failClosed, prov("stranger", "maint"), maintainerLookup("maint"), external(true, "maint"));
    expect(v.executable).toBe(true);
  });

  it("an APPROVED external issue still requires a maintainer PROMOTER on the fail-closed path", async () => {
    const v = await evaluateClaimTrust(failClosed, prov("stranger", "intruder"), maintainerLookup("maint"), external(true, "maint"));
    expect(v.executable).toBe(false);
    expect(v.reason).toContain("untrusted ready-for-agent promoter");
  });

  it("leaves the non-external claim decision unchanged when no external state is passed", async () => {
    const v = await evaluateClaimTrust(failClosed, prov("maint", "maint2"), maintainerLookup("maint", "maint2"));
    expect(v.executable).toBe(true);
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
