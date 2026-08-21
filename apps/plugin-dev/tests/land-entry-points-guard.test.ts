/**
 * Every way a change reaches the trunk is written down, and the table is real
 * (Ticket #4138, Spec #4129, ADR 0154).
 *
 * The Spec's risk mitigation is the deliverable: **enumerate all land entry
 * points rather than discovering them.** Discovery is what a reviewer does once
 * and an agent never repeats, so the enumeration is a declared table and this
 * ratchet pins it both ways — nothing declared is fiction, and nothing
 * undeclared merges. The second direction is the one that survives us: a new
 * entry point inherits the obligation the moment its first `landPr` or
 * `handoffMergeCustody` lands, rather than the next time somebody remembers to
 * look.
 *
 * Every declared entry also names the TEST that states its Countersign source, so
 * "which head is this judged on?" has an answer per door rather than a rule
 * somewhere and five doors nobody re-read.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAND_ENTRY_POINTS,
  LAND_MERGE_PRIMITIVES,
  LAND_PRIMITIVE_EXEMPTIONS,
  auditLandEntryPoints,
  type LandSweptFile,
} from "../src/core/land-entry-points.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The roots a merge can be written in: the runtime, the daemon, the engine. */
const SWEPT_ROOTS = [
  "apps/plugin-dev/src",
  "apps/redskilled/src",
  "packages/worker/src",
];

function collect(root: string, into: LandSweptFile[]): void {
  const absolute = join(REPO_ROOT, root);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) {
      collect(join(root, entry), into);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".test-support.ts")) {
      continue;
    }
    into.push({
      path: relative(REPO_ROOT, path).split(sep).join("/"),
      text: readFileSync(path, "utf8"),
    });
  }
}

const SWEPT: LandSweptFile[] = [];
for (const root of SWEPT_ROOTS) collect(root, SWEPT);

describe("land entry points are enumerated, not discovered (#4138)", () => {
  it("sweeps a tree that actually exists", () => {
    expect(SWEPT.length).toBeGreaterThan(100);
  });

  it("the live tree matches the declared table in both directions", () => {
    const findings = auditLandEntryPoints(SWEPT);
    expect(findings.map((finding) => finding.reason)).toEqual([]);
  });

  it("declares each entry once, with a Countersign source a reader can act on", () => {
    const ids = LAND_ENTRY_POINTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of LAND_ENTRY_POINTS) {
      expect(entry.countersignSource.trim().length).toBeGreaterThan(60);
      expect(entry.why.trim().length).toBeGreaterThan(20);
    }
  });

  it("names the five paths Spec #4129 enumerates, plus the two doors the ACP path is really made of", () => {
    expect(LAND_ENTRY_POINTS.map((entry) => entry.id)).toEqual([
      "afk-lifecycle-landing",
      "reconcile-adopt-branch",
      "land-tool",
      "merge-driver",
      "worker-land-request",
      "acp-custody-handoff-method",
      "acp-land-method",
    ]);
  });

  it("pins the ONE entrance that asks nothing, and what closing it would take", () => {
    const unenforced = LAND_ENTRY_POINTS.filter((entry) => entry.enforcement === "unenforced");
    expect(unenforced.map((entry) => entry.id)).toEqual(["acp-custody-handoff-method"]);
    expect(unenforced[0]?.gap).toContain("armed_head");
  });

  it("refuses an unenforced entrance that states no gap", () => {
    const unenforced = LAND_ENTRY_POINTS.find((entry) => entry.enforcement === "unenforced")!;
    const findings = auditLandEntryPoints(
      [{ path: unenforced.module, text: `export function ${unenforced.entry}() {}` }],
      [{ ...unenforced, gap: "todo" }],
      [],
    );
    expect(findings.map((finding) => finding.kind)).toEqual(["unstated-gap"]);
  });

  it("every entry names a test that exists and states its Countersign source", () => {
    for (const entry of LAND_ENTRY_POINTS) {
      const text = readFileSync(join(REPO_ROOT, entry.test), "utf8");
      expect(text.includes(entry.entry) || text.includes(entry.id)).toBe(true);
      expect(text).toContain("#4138");
    }
  });

  it("refuses a module that reaches a primitive without declaring itself", () => {
    const findings = auditLandEntryPoints([
      ...SWEPT,
      { path: "apps/plugin-dev/src/core/backdoor.ts", text: "await landPr(exec, {});" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("undeclared-entry-point");
    expect(findings[0]?.reason).toContain("landPr");
  });

  it("reads a primitive named only in PROSE as documentation, never as a reach", () => {
    const findings = auditLandEntryPoints([
      ...SWEPT,
      { path: "apps/plugin-dev/src/core/notes.ts", text: "// landPr used to live here.\nexport const x = 1;" },
    ]);
    expect(findings).toEqual([]);
  });

  // The declaration-side rules are proven against a ONE-FILE tree: mixing them
  // with the live sweep would drown one finding in the sweep's own answers.
  const LANDING = LAND_ENTRY_POINTS[0]!;
  const oneFile = (text: string): LandSweptFile[] => [{ path: LANDING.module, text }];
  const WIRED = `import { landHeadPrecondition } from "./x.js";\nexport async function ${LANDING.entry}() {}`;

  it("refuses a declaration whose module or entry symbol is gone", () => {
    const gone = auditLandEntryPoints(oneFile(WIRED), [
      { ...LANDING, module: "apps/plugin-dev/src/core/gone.ts" },
    ], []);
    expect(gone.map((finding) => finding.kind)).toEqual(["missing-module"]);

    const renamed = auditLandEntryPoints(oneFile(WIRED), [
      { ...LANDING, entry: "doLandingRenamed" },
    ], []);
    expect(renamed.map((finding) => finding.kind)).toEqual(["missing-entry"]);
  });

  it("refuses an enforcement claim the module never makes", () => {
    const findings = auditLandEntryPoints(oneFile(WIRED), [
      { ...LANDING, proof: "someGateNobodyImports" },
    ], []);
    expect(findings.map((finding) => finding.kind)).toEqual(["unproven-enforcement"]);
    expect(findings[0]?.reason).toContain("enforces nothing");
  });

  it("refuses a delegation to an entry point nothing declares", () => {
    const tool = LAND_ENTRY_POINTS.find((entry) => entry.id === "land-tool")!;
    const findings = auditLandEntryPoints(
      [{ path: tool.module, text: `export function ${tool.entry}() {}` }],
      [{ ...tool, delegatesTo: "nowhere" }],
      [],
    );
    expect(findings.map((finding) => finding.kind)).toEqual(["unknown-delegation"]);
  });

  it("refuses an exemption whose file stopped reaching a primitive", () => {
    const findings = auditLandEntryPoints(
      SWEPT,
      LAND_ENTRY_POINTS,
      [...LAND_PRIMITIVE_EXEMPTIONS, { path: "apps/plugin-dev/src/core/config.ts", why: "stale" }],
    );
    expect(findings.map((finding) => finding.kind)).toEqual(["stale-exemption"]);
  });

  it("every exemption states one file and one reason — never a glob", () => {
    for (const exemption of LAND_PRIMITIVE_EXEMPTIONS) {
      expect(exemption.path).toMatch(/\.ts$/);
      expect(exemption.path).not.toContain("*");
      expect(exemption.why.trim().length).toBeGreaterThan(30);
    }
  });

  it("the primitives are named surfaces, not the word 'merge'", () => {
    expect([...LAND_MERGE_PRIMITIVES]).toEqual([
      "landPr",
      "landMerge",
      "handoffMergeCustody",
      "runMergeDriverPass",
      "runCastleLanding",
    ]);
  });

  it("runs in every gate cone as a repo-wide invariant", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain("invariants:land-entry-points");
  });
});
