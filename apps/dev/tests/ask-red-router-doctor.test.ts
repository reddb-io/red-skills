import { describe, expect, it } from "vitest";
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

    expect(toon).toContain("skills[3]{skill,inRegisteredSet,inRouter,verdict}");
    expect(toon).toContain("findings[2]{skill,kind,verdict}");
    expect(toon).toContain("go,true,false,warn");
    expect(toon).toContain("ghost-flow,false,true,warn");
    expect(toon).not.toContain("{\n");
  });
});
