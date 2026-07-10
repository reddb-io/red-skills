import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  auditAskRedRouterCoverage,
  renderAskRedRouterCoverageToon,
} from "../src/core/ask-red-router-doctor.js";

describe("auditAskRedRouterCoverage", () => {
  it("flags registered skills missing from ask-red and stale router entries", () => {
    const report = auditAskRedRouterCoverage({
      registeredSkills: ["afk", "go", "doctor"],
      routerSkills: ["afk", "ghost-flow"],
    });

    expect(report.findings).toEqual([
      {
        skill: "doctor",
        kind: "missing-from-router",
        verdict: "warn",
        reason: "registered skill /doctor is missing from ask-red",
        remediation: "update ask-red so the router covers the registered skill set",
      },
      {
        skill: "go",
        kind: "missing-from-router",
        verdict: "warn",
        reason: "registered skill /go is missing from ask-red",
        remediation: "update ask-red so the router covers the registered skill set",
      },
      {
        skill: "ghost-flow",
        kind: "stale-router-entry",
        verdict: "warn",
        reason: "ask-red routes /ghost-flow but that skill is not registered",
        remediation: "update ask-red so the router covers the registered skill set",
      },
    ]);
  });

  it("renders a compact doctor scorecard", () => {
    const toon = renderAskRedRouterCoverageToon(
      auditAskRedRouterCoverage({
        registeredSkills: ["afk", "go"],
        routerSkills: ["afk", "ghost-flow"],
      }),
    );
    const decoded = decode(toon) as {
      skills: Array<{ skill: string; inRegisteredSet: boolean; inRouter: boolean; verdict: string }>;
      findings: Array<{ skill: string; kind: string; verdict: string }>;
    };

    expect(toon).toContain("skills[3]{skill,inRegisteredSet,inRouter,verdict}");
    expect(toon).toContain("findings[2]{skill,kind,verdict}");
    expect(decoded.skills).toContainEqual({ skill: "go", inRegisteredSet: true, inRouter: false, verdict: "warn" });
    expect(decoded.skills).toContainEqual({ skill: "ghost-flow", inRegisteredSet: false, inRouter: true, verdict: "warn" });
    expect(decoded.findings).toHaveLength(2);
    expect(toon).not.toContain("{\n");
  });
});
