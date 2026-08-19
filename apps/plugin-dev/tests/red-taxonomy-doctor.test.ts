import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  auditRedTaxonomy,
  renderRedTaxonomyReportToon,
  type RedTaxonomyEntry,
} from "../src/core/red-taxonomy-doctor.js";

function entry(path: string, kind: "file" | "dir" = "dir"): RedTaxonomyEntry {
  return { path, kind };
}

describe("auditRedTaxonomy — ADR 0098 lane registry", () => {
  it("reports the four taxonomy violation classes with their target lanes", () => {
    const report = auditRedTaxonomy([
      entry(".red/tmp/orphan.txt", "file"),
      entry(".red/tmp/random-lane"),
      entry(".red/tmp/afk-supervisor.pid", "file"),
      entry(".red/cache"),
    ]);

    expect(report.findings).toEqual([
      {
        path: ".red/cache",
        kind: "undocumented-red-root",
        verdict: "warn",
        reason: ".red/cache is not documented by the ADR 0098 top-level taxonomy",
        target: "extend ADR 0098 or move content into a documented .red tier",
      },
      {
        path: ".red/tmp/afk-supervisor.pid",
        kind: "durable-state-in-tmp",
        verdict: "error",
        reason: ".red/tmp/afk-supervisor.pid is durable dev/AFK supervisor state in the disposable tmp tier",
        target: ".red/tmp/supervisors/default/afk-supervisor.pid",
      },
      {
        path: ".red/tmp/orphan.txt",
        kind: "loose-tmp-file",
        verdict: "warn",
        reason: ".red/tmp/orphan.txt is a loose file at the .red/tmp root",
        target: ".red/tmp/scratch/",
      },
      {
        path: ".red/tmp/random-lane",
        kind: "unknown-tmp-lane",
        verdict: "warn",
        reason: ".red/tmp/random-lane is not a registered .red/tmp lane",
        target: "registered .red/tmp lane (or extend ADR 0098)",
      },
    ]);
  });

  it("reports unregistered worktree sub-lanes without flagging registered ones", () => {
    const report = auditRedTaxonomy([
      entry(".red/tmp/worktrees/manual"),
      entry(".red/tmp/worktrees/random-lane"),
    ]);

    expect(report.findings).toEqual([
      {
        path: ".red/tmp/worktrees/random-lane",
        kind: "unknown-tmp-lane",
        verdict: "warn",
        reason: ".red/tmp/worktrees/random-lane is not a registered .red/tmp/worktrees lane",
        target: "registered .red/tmp/worktrees lane (or extend ADR 0098)",
      },
    ]);
  });

  it("does not report taxonomy findings for a conforming .red tree", () => {
    const report = auditRedTaxonomy([
      entry(".red/config.yaml", "file"),
      entry(".red/adr"),
      entry(".red/contexts"),
      entry(".red/memory"),
      entry(".red/state/afk"),
      entry(".red/state/statusline"),
      entry(".red/state/branch-lock.yaml", "file"),
      entry(".red/state/red-skills.rdb", "file"),
      entry(".red/tmp/workers"),
      entry(".red/tmp/go-workers"),
      entry(".red/tmp/scout-workers"),
      entry(".red/tmp/claims"),
      entry(".red/tmp/waits"),
      entry(".red/tmp/worktrees"),
      entry(".red/tmp/worktrees/manual"),
      entry(".red/tmp/scratch"),
      entry(".red/tmp/diagnostics"),
      entry(".red/researches"),
    ]);

    expect(report.findings).toEqual([]);
  });
});

describe("renderRedTaxonomyReportToon", () => {
  it("renders read-only doctor findings as compact TOON", () => {
    const toon = renderRedTaxonomyReportToon(
      auditRedTaxonomy([entry(".red/tmp/statusline-cache.json", "file")]),
    );
    const decoded = decode(toon) as {
      findings: Array<{ path: string; kind: string; verdict: string; target: string }>;
    };

    expect(toon).toContain("findings[1]{path,kind,verdict,target}");
    expect(decoded.findings).toEqual([
      {
        path: ".red/tmp/statusline-cache.json",
        kind: "durable-state-in-tmp",
        verdict: "error",
        target: ".red/state/statusline/statusline-cache.toon",
      },
    ]);
    expect(toon).not.toContain("{\n");
  });
});
