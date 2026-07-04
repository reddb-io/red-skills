import { describe, expect, it } from "vitest";
import {
  classifySourceTrust,
  isTrustedSource,
  TRUSTED_ASSOCIATIONS,
} from "../src/core/source-trust.js";
import type { ActorTrustVerdict } from "../src/core/trust-gate.js";

describe("classifySourceTrust", () => {
  it("bots/apps resolve to automation regardless of association", () => {
    expect(classifySourceTrust({ isBot: true })).toBe("automation");
    // A bot association would never override the bot flag.
    expect(classifySourceTrust({ isBot: true, authorAssociation: "OWNER" })).toBe("automation");
  });

  it("OWNER/MEMBER/COLLABORATOR associations are trusted without a lookup", () => {
    for (const assoc of TRUSTED_ASSOCIATIONS) {
      expect(classifySourceTrust({ authorAssociation: assoc })).toBe("trusted");
    }
    // case-insensitive / whitespace tolerant.
    expect(classifySourceTrust({ authorAssociation: " collaborator " })).toBe("trusted");
  });

  it("CONTRIBUTOR/FIRST_TIMER/NONE without an override are dubious", () => {
    for (const assoc of ["CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      expect(classifySourceTrust({ authorAssociation: assoc })).toBe("dubious");
    }
    // an absent association is the unknown bucket → dubious.
    expect(classifySourceTrust({})).toBe("dubious");
  });

  it("a positive trust-gate override promotes a dubious association to trusted", () => {
    const bases: ActorTrustVerdict["basis"][] = ["allowlist", "write-access", "codeowners"];
    for (const basis of bases) {
      const verdict: ActorTrustVerdict = { executable: true, basis };
      expect(classifySourceTrust({ authorAssociation: "NONE", trustVerdict: verdict })).toBe(
        "trusted",
      );
    }
  });

  it("permissive-default never promotes — the guidance channel needs a positive signal", () => {
    const verdict: ActorTrustVerdict = { executable: true, basis: "permissive-default" };
    expect(classifySourceTrust({ authorAssociation: "NONE", trustVerdict: verdict })).toBe("dubious");
  });

  it("a refusing verdict leaves the author dubious", () => {
    const verdict: ActorTrustVerdict = { executable: false, reason: "not a maintainer" };
    expect(classifySourceTrust({ authorAssociation: "CONTRIBUTOR", trustVerdict: verdict })).toBe(
      "dubious",
    );
  });
});

describe("isTrustedSource", () => {
  it("only the trusted level grants authority", () => {
    expect(isTrustedSource("trusted")).toBe(true);
    expect(isTrustedSource("dubious")).toBe(false);
    expect(isTrustedSource("automation")).toBe(false);
  });

  it("undefined is a legacy pass-through (promotes)", () => {
    expect(isTrustedSource(undefined)).toBe(true);
  });
});
