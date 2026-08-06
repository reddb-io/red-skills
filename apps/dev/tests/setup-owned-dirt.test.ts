import { describe, expect, it } from "vitest";
import {
  auditSetupOwnedDirt,
  classifyDirtyTree,
  classifySetupDirtCollision,
  describeCleanTreeRefusal,
  describeSetupDirtCollisionRefusal,
  describeSupersededSetupDirt,
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

  it("keeps each dirty path's porcelain code, so untracked can be told from edited", () => {
    const tree = classifyDirtyTree("?? .red/.gitignore\n M .red/config.yaml\n");
    expect(tree.dirty.map((entry) => entry.status)).toEqual(["??", " M"]);
  });

  it("reports a clean tree as neither dirty nor setup-owned", () => {
    const tree = classifyDirtyTree("\n");
    expect(tree.dirty).toEqual([]);
    expect(tree.setupOwned).toEqual([]);
    expect(tree.foreign).toEqual([]);
  });

  it("tolerates exactly the ADR 0092 documentation set without calling it setup-owned (#3349)", () => {
    const tree = classifyDirtyTree(
      " M .red/CONTEXT.md\n M .red/CONTEXT-MAP.md\n M .red/contexts/dev/CONTEXT.md\n?? .red/adr/0132-trunk.md\n M apps/dev/src/x.ts\n",
    );

    expect(tree.tolerated).toEqual([
      ".red/CONTEXT.md",
      ".red/CONTEXT-MAP.md",
      ".red/contexts/dev/CONTEXT.md",
      ".red/adr/0132-trunk.md",
    ]);
    expect(tree.setupOwned).toEqual([]);
    expect(tree.foreign).toEqual(["apps/dev/src/x.ts"]);
  });

  it("does not dissolve the guard for paths merely adjacent to the documentation set (#3349)", () => {
    const tree = classifyDirtyTree(
      " M .red/CONTEXT.md.bak\n M .red/contexts-old/x.md\n M .red/adr-old/0132.md\n M apps/dev/src/x.ts\n",
    );

    expect(tree.tolerated).toEqual([]);
    expect(tree.foreign).toEqual([
      ".red/CONTEXT.md.bak",
      ".red/contexts-old/x.md",
      ".red/adr-old/0132.md",
      "apps/dev/src/x.ts",
    ]);
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

/**
 * #3155 — the tolerance stopped at the verdict. `SETUP_OWNED_FILES` are exactly
 * the files a maturing repo eventually COMMITS, so the untracked copy setup
 * wrote and the tracked copy trunk now carries collide by definition, and the
 * `--ff-only` merge aborted under a `guard=passed` receipt.
 */
describe("classifySetupDirtCollision", () => {
  it("calls an untracked local copy the incoming commits track SUPERSEDED", () => {
    const collision = classifySetupDirtCollision(classifyDirtyTree("?? .red/.gitignore\n"), [
      ".red/.gitignore",
      "apps/dev/src/x.ts",
    ]);
    expect(collision.superseded).toEqual([".red/.gitignore"]);
    expect(collision.conflicting).toEqual([]);
  });

  it("calls a tracked, locally-edited path the incoming commits touch CONFLICTING", () => {
    const collision = classifySetupDirtCollision(classifyDirtyTree(" M .red/config.yaml\n"), [".red/config.yaml"]);
    expect(collision.conflicting).toEqual([".red/config.yaml"]);
    expect(collision.superseded).toEqual([]);
  });

  it("ignores tolerated dirt the incoming commits never touch — nothing collides", () => {
    const collision = classifySetupDirtCollision(
      classifyDirtyTree("?? .red/.gitignore\n M .red/config.yaml\n"),
      ["apps/dev/src/x.ts"],
    );
    expect(collision).toEqual({ superseded: [], conflicting: [] });
  });

  it("never classifies foreign dirt — the clean-tree condition already refused it", () => {
    const collision = classifySetupDirtCollision(classifyDirtyTree("?? notes.md\n"), ["notes.md"]);
    expect(collision).toEqual({ superseded: [], conflicting: [] });
  });
});

describe("collision evidence", () => {
  it("says where a superseded file went, so nothing reads as deleted", () => {
    const evidence = describeSupersededSetupDirt([".red/.gitignore"]);
    expect(evidence).toContain(".red/.gitignore");
    expect(evidence).toContain(".red/tmp/superseded-setup-dirt");
  });

  it("names the blocking path and the repair in the refusal", () => {
    const evidence = describeSetupDirtCollisionRefusal([".red/config.yaml"], "origin/main");
    expect(evidence).toContain("dirt-collision");
    expect(evidence).toContain(".red/config.yaml");
    expect(evidence).toContain("origin/main");
    expect(evidence).toContain("commit or stash");
  });
});
