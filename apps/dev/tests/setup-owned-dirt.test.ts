import { describe, expect, it } from "vitest";
import {
  auditSetupOwnedDirt,
  classifyDirtyTree,
  describeCleanTreeRefusal,
  isSetupOwnedPath,
  renderSetupOwnedDirtToon,
  SETUP_OWNED_DIRT_REMEDIATION,
} from "../src/core/setup-owned-dirt.js";

/**
 * #3106 — `/red-setup` writes `.red/config.yaml`, `.red/.gitignore` and hook
 * scripts it is forbidden to `git add`, and the boot probe refused to
 * fast-forward the local trunk on ANY dirty tree. Every fresh repository was
 * therefore bricked at first boot. These tests pin the reconciliation: dirt in
 * paths setup owns is tolerated, everything else still refuses, and a refusal
 * names the paths instead of sending the reader to git history.
 */
describe("isSetupOwnedPath", () => {
  it("owns the three files the setup contract forbids committing", () => {
    expect(isSetupOwnedPath(".red/config.yaml")).toBe(true);
    expect(isSetupOwnedPath(".red/.gitignore")).toBe(true);
    expect(isSetupOwnedPath(".red/hooks/pre_merge/red-test.sh")).toBe(true);
  });

  it("does not own ordinary work, nor .red paths setup does not write", () => {
    expect(isSetupOwnedPath("apps/dev/src/core/boot.ts")).toBe(false);
    expect(isSetupOwnedPath(".red/adr/0132-x.md")).toBe(false);
    expect(isSetupOwnedPath(".red/contexts/dev/CONTEXT.md")).toBe(false);
    // A path that merely starts with the same characters is a different file.
    expect(isSetupOwnedPath(".red/config.yaml.bak")).toBe(false);
    expect(isSetupOwnedPath(".red/hooks-old/x.sh")).toBe(false);
  });
});

describe("classifyDirtyTree", () => {
  it("splits porcelain output into setup-owned and foreign dirt", () => {
    const tree = classifyDirtyTree(" M .red/config.yaml\n?? .red/.gitignore\n M apps/dev/src/x.ts\n");
    expect(tree.setupOwned).toEqual([".red/config.yaml", ".red/.gitignore"]);
    expect(tree.foreign).toEqual(["apps/dev/src/x.ts"]);
    expect(tree.dirty).toHaveLength(3);
  });

  it("reads a rename's destination and unquotes a quoted path", () => {
    const tree = classifyDirtyTree('R  old.ts -> apps/new.ts\n M ".red/config.yaml"\n');
    expect(tree.foreign).toEqual(["apps/new.ts"]);
    expect(tree.setupOwned).toEqual([".red/config.yaml"]);
  });

  it("reports a clean tree as neither dirty nor setup-owned", () => {
    const tree = classifyDirtyTree("\n");
    expect(tree.dirty).toEqual([]);
    expect(tree.setupOwned).toEqual([]);
    expect(tree.foreign).toEqual([]);
  });
});

describe("describeCleanTreeRefusal", () => {
  it("names the offending paths instead of counting them", () => {
    const evidence = describeCleanTreeRefusal(classifyDirtyTree(" M apps/dev/src/x.ts\n?? notes.md\n"));
    expect(evidence).toContain("2 dirty path(s)");
    expect(evidence).toContain("apps/dev/src/x.ts");
    expect(evidence).toContain("notes.md");
  });

  it("says which of the offenders /red-setup wrote, and how to close the loop", () => {
    const evidence = describeCleanTreeRefusal(
      classifyDirtyTree(" M .red/config.yaml\n M apps/dev/src/x.ts\n"),
    );
    expect(evidence).toContain(".red/config.yaml");
    expect(evidence).toContain("/red-setup");
    expect(evidence).toContain("commit");
  });

  it("bounds the list rather than printing an unbounded tree", () => {
    const porcelain = Array.from({ length: 12 }, (_, i) => ` M src/f${i}.ts`).join("\n");
    const evidence = describeCleanTreeRefusal(classifyDirtyTree(porcelain));
    expect(evidence).toContain("12 dirty path(s)");
    expect(evidence).toContain("+6 more");
  });
});

describe("auditSetupOwnedDirt (red-doctor check)", () => {
  it("is ok on a tree with no setup-owned dirt", () => {
    const report = auditSetupOwnedDirt(classifyDirtyTree(" M apps/dev/src/x.ts\n"));
    expect(report.row.verdict).toBe("ok");
    expect(report.findings).toEqual([]);
  });

  it("warns when /red-setup's own writes are still uncommitted", () => {
    const report = auditSetupOwnedDirt(classifyDirtyTree(" M .red/config.yaml\n?? .red/.gitignore\n"));
    expect(report.row.verdict).toBe("warn");
    expect(report.row.check).toBe("setup-owned-dirt");
    expect(report.row.evidence).toContain(".red/config.yaml");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.paths).toEqual([".red/config.yaml", ".red/.gitignore"]);
    expect(report.findings[0]?.remediation).toBe(SETUP_OWNED_DIRT_REMEDIATION);
  });

  it("renders TOON, never JSON, for the machine-readable lane", () => {
    const toon = renderSetupOwnedDirtToon(auditSetupOwnedDirt(classifyDirtyTree(" M .red/config.yaml\n")));
    expect(toon).toContain("setup-owned-dirt");
    expect(toon.trim().startsWith("{")).toBe(false);
  });
});
