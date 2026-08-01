import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../src/core/config.js";
import { declaredHitlTypeLabels } from "../src/core/hitl-type-declaration.js";
import {
  applyHitlTypeDeclarationFix,
  auditHitlTypeDeclaration,
} from "../src/core/hitl-type-declaration-doctor.js";

const ENABLED = "plugins:\n  dev:\n    enabled: true\n";
const DECLARED = [
  "plugins:",
  "  dev:",
  "    enabled: true",
  "    afk:",
  "      labels:",
  "        hitl_types:",
  "          - wayfinder:grilling",
  "          - wayfinder:prototype",
  "",
].join("\n");

describe("auditHitlTypeDeclaration", () => {
  it("flags a wayfinder type label that no hitl_types entry declares", () => {
    const report = auditHitlTypeDeclaration({
      installedLabels: ["bug", "wayfinder:map", "wayfinder:grilling", "wayfinder:prototype"],
      configText: ENABLED,
    });

    expect(report.row.verdict).toBe("warn");
    expect(report.findings.map((finding) => finding.label)).toEqual([
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
    expect(report.row.evidence).toContain("wayfinder:grilling");
    expect(report.plan?.changed).toBe(true);
  });

  it("passes when every installed HUMAN-ONLY label is declared", () => {
    const report = auditHitlTypeDeclaration({
      installedLabels: ["wayfinder:grilling", "wayfinder:prototype", "wayfinder:research"],
      configText: DECLARED,
    });

    expect(report.row.verdict).toBe("ok");
    expect(report.findings).toEqual([]);
    expect(report.plan).toBeNull();
  });

  it("flags only the half that is missing", () => {
    const report = auditHitlTypeDeclaration({
      installedLabels: ["wayfinder:grilling", "wayfinder:prototype"],
      configText: "plugins:\n  dev:\n    afk:\n      labels:\n        hitl_types:\n          - wayfinder:grilling\n",
    });

    expect(report.findings.map((finding) => finding.label)).toEqual(["wayfinder:prototype"]);
    expect(report.checked.declaredTypes).toBe(1);
  });

  it("stays silent about a declaration whose label is not installed", () => {
    const report = auditHitlTypeDeclaration({ installedLabels: ["bug"], configText: DECLARED });

    expect(report.row.verdict).toBe("ok");
    expect(report.row.evidence).toContain("no HUMAN-ONLY type label");
  });

  it("reports an unreadable label list as an error rather than a clean repo", () => {
    const report = auditHitlTypeDeclaration({
      installedLabels: null,
      configText: ENABLED,
      transportFailures: ["gh label list failed: HTTP 403"],
    });

    expect(report.row.verdict).toBe("error");
    expect(report.findings[0]?.reason).toContain("HTTP 403");
  });

  it("treats a repo with no issue tracker as nothing to check", () => {
    const report = auditHitlTypeDeclaration({ installedLabels: null, configText: ENABLED });

    expect(report.row.verdict).toBe("ok");
    expect(report.row.evidence).toContain("no issue tracker");
  });

  it("flags the pair but delegates to /red-setup when there is no config file", () => {
    const report = auditHitlTypeDeclaration({ installedLabels: ["wayfinder:grilling"], configText: null });

    expect(report.row.verdict).toBe("warn");
    expect(report.plan).toBeNull();
    expect(report.findings[0]?.remediation).toContain("/red-setup");
  });

  it("refuses to plan an edit against a config the loader cannot parse", () => {
    const report = auditHitlTypeDeclaration({
      installedLabels: ["wayfinder:grilling"],
      configText: "plugins:\n   dev: \"unclosed\n",
    });

    expect(report.row.verdict).toBe("error");
    expect(report.plan).toBeNull();
    expect(report.findings[0]?.reason).toContain("does not parse");
  });
});

describe("applyHitlTypeDeclarationFix", () => {
  const report = auditHitlTypeDeclaration({
    installedLabels: ["wayfinder:grilling", "wayfinder:prototype"],
    configText: ENABLED,
  });

  it("writes the declaration under --fix --yes and shows the diff first", async () => {
    const writes: string[] = [];
    const previews: string[] = [];

    const receipt = await applyHitlTypeDeclarationFix(report, { fix: true, approved: true }, {
      writeConfig: async (text) => {
        writes.push(text);
      },
      showDiffPreview: async (diff) => {
        previews.push(diff);
      },
    });

    expect(receipt.status).toBe("applied");
    expect(receipt.evidence).toContain("wayfinder:grilling");
    expect(previews[0]).toContain("+          - wayfinder:grilling");
    expect(declaredHitlTypeLabels(parseConfigYaml(writes[0] ?? ""))).toEqual([
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
  });

  it("writes nothing without --fix, and nothing without approval", async () => {
    const writes: string[] = [];
    const io = {
      writeConfig: async (text: string) => {
        writes.push(text);
      },
    };

    expect((await applyHitlTypeDeclarationFix(report, { fix: false, approved: true }, io)).status).toBe("noop");
    const declined = await applyHitlTypeDeclarationFix(report, { fix: true, approved: false }, io);
    expect(declined.status).toBe("declined");
    expect(declined.evidence).toContain("approval required");
    expect(writes).toEqual([]);
  });

  it("is a noop when the audit found nothing to fix", async () => {
    const clean = auditHitlTypeDeclaration({
      installedLabels: ["wayfinder:grilling", "wayfinder:prototype"],
      configText: DECLARED,
    });

    const receipt = await applyHitlTypeDeclarationFix(clean, { fix: true, approved: true }, {
      writeConfig: async () => {
        throw new Error("must not write");
      },
    });

    expect(receipt.status).toBe("noop");
  });
});
