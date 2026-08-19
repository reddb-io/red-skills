import { describe, expect, it } from "vitest";
import {
  interactiveWorktreeDirectory,
  REDSKILLED_INTERACTIVE_WORKTREE_LANE,
} from "@reddb-io/redskilled/acp-worktree";
import {
  auditWorktreeLanes,
  parseWorktreePorcelain,
  REGISTERED_WORKTREE_LANES,
} from "../src/core/worktree-lane-doctor.js";

const ROOT = "/repo";

describe("auditWorktreeLanes — every worktree lives in a lane we own", () => {
  it("passes the primary checkout and every registered lane", () => {
    const report = auditWorktreeLanes(ROOT, [
      { path: "/repo" },
      ...REGISTERED_WORKTREE_LANES.map((lane) => ({ path: `/repo/.red/tmp/worktrees/${lane}/slug` })),
      { path: "/repo/.red/tmp/workers/wAAA/3466/worktree" },
      { path: "/repo/.red/tmp/go-workers/gBBB/3467/worktree" },
      { path: "/repo/.red/tmp/scout-workers/sCCC/3468/worktree" },
    ]);

    expect(report.verdict).toBe("ok");
    expect(report.findings).toEqual([]);
  });

  it("names the host that left a worktree outside every lane", () => {
    // The lane this repo was already carrying: 440MB a host CLI flag created
    // before any tool call existed, so the Bash pre-exec guard never saw it.
    const report = auditWorktreeLanes(ROOT, [
      { path: "/repo" },
      { path: "/repo/.muse/worktrees/red-skills-63dcb17d", branch: "refs/heads/muse/session-63dcb17d" },
    ]);

    expect(report.verdict).toBe("warn");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.path).toBe(".muse/worktrees/red-skills-63dcb17d");
    expect(report.findings[0]?.reason).toContain("Muse `--worktree` run");
    expect(report.findings[0]?.reason).toContain("no janitor reclaims it");
  });

  it("still reports a host it does not recognise, rather than passing it", () => {
    const report = auditWorktreeLanes(ROOT, [{ path: "/repo/.some-future-cli/wt/a" }]);

    expect(report.findings[0]?.reason).toContain("an unrecognised creator");
    expect(report.findings[0]?.kind).toBe("unregistered-lane");
  });

  it("reports an unregistered lane under .red/tmp/worktrees too", () => {
    const report = auditWorktreeLanes(ROOT, [{ path: "/repo/.red/tmp/worktrees/invented/x" }]);
    expect(report.findings).toHaveLength(1);
  });

  it("leaves a worktree outside the repo alone", () => {
    // A maintainer's scratch clone elsewhere on disk is not this repo's lane to
    // govern, and reddening it would teach them to ignore the row.
    const report = auditWorktreeLanes(ROOT, [{ path: "/home/dev/other-copy" }]);
    expect(report.verdict).toBe("ok");
  });

  it("parses git's porcelain, detached entries included", () => {
    const facts = parseWorktreePorcelain(
      [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo/.red/tmp/worktrees/manual/slug",
        "HEAD def456",
        "detached",
        "",
      ].join("\n"),
    );

    expect(facts).toEqual([
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/.red/tmp/worktrees/manual/slug" },
    ]);
  });
});

// The daemon creates the interactive worktree now (ADR 0150 §4, issue #4021),
// and it creates it in the human's own checkout — the one place the dev command
// proxy and this doctor both govern. So the lane it writes into is pinned HERE
// rather than trusted: a daemon that started landing worktrees in a lane nobody
// registered would be refused by the proxy in a human's checkout, at the moment
// they asked for a worktree, with nothing in the gate having said so.
describe("the daemon's interactive lane is a lane this repo registers", () => {
  it("lands worktree_add in a registered lane under .red/tmp/", () => {
    expect(REGISTERED_WORKTREE_LANES).toContain(REDSKILLED_INTERACTIVE_WORKTREE_LANE);
    expect(interactiveWorktreeDirectory("4021-worktree-add")).toBe(
      ".red/tmp/worktrees/manual/4021-worktree-add",
    );
  });

  it("is judged registered by the doctor that reads git's own inventory", () => {
    const report = auditWorktreeLanes(ROOT, [
      { path: ROOT },
      { path: `${ROOT}/${interactiveWorktreeDirectory("4021-worktree-add")}` },
    ]);

    expect(report.verdict).toBe("ok");
    expect(report.findings).toEqual([]);
  });
});
