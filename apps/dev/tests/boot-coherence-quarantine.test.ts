// boot-coherence-quarantine.test.ts — label/body coherence probe quarantine behaviour at boot (#2386).
//
// A single incoherent issue (ready-for-agent + active Current blocker in body) must
// never halt every worker boot. The probe quarantines the issue autonomously —
// ready-for-agent → needs-triage + one comment — and boot continues.

import { describe, expect, it, vi } from "vitest";
import { BootHaltError, makeDeps, options, runBoot } from "./boot.helpers.js";

const BLOCKER_BODY = [
  "## Current blocker",
  "",
  "<!-- red:blocker-state v1 -->",
  "status: blocked",
  "kind: validation",
  "ref: #1965",
  "summary: Gate failed before the manual requeue.",
  "next: Confirm the issue is safe to delegate again.",
  "<!-- /red:blocker-state -->",
].join("\n");

const INCOHERENT_ISSUE = {
  number: 1971,
  title: "Some work item",
  labels: ["ready-for-agent", "priority:normal"],
  body: BLOCKER_BODY,
};

function coherenceOptions(over: { issues?: typeof INCOHERENT_ISSUE[]; fail?: boolean } = {}) {
  const fail = over.fail ?? false;
  return options({
    operationalProbes: {
      remoteUrls: [],
      labelBodyCoherence: {
        listOpenReadyIssues: async () => over.issues ?? [INCOHERENT_ISSUE],
      },
    },
    precheck: {
      ghInstalled: true,
      ghAuthenticated: true,
      isGitRepo: true,
      remoteUrls: ["git@github.com:reddb-io/red-skills.git"],
      hasMainBranch: true,
      currentBranch: "main",
      pnpmInstalled: true,
      labelBodyCoherence: {
        listOpenReadyIssues: async () => over.issues ?? [INCOHERENT_ISSUE],
      },
    },
  });
}

describe("runBoot label/body coherence probe quarantine", () => {
  it("quarantines the incoherent issue and boots normally instead of halting", async () => {
    const { deps, ghCalls } = makeDeps();

    const result = await runBoot(deps, coherenceOptions());

    expect(result.bootstrap).toEqual({ ok: true });
    const edit = ghCalls.editLabels.find((e) => e.issue === 1971);
    expect(edit).toBeDefined();
    expect(edit?.remove).toContain("ready-for-agent");
    expect(edit?.add).toContain("needs-triage");
    const comment = ghCalls.comment.find((c) => c.issue === 1971);
    expect(comment).toBeDefined();
    expect(comment?.body).toContain("quarantined this issue");
    expect(comment?.body).toContain("ready-for-agent");
    expect(comment?.body).toContain("kind=validation");
  });

  it("idempotent on second boot: probe sees no ready-labelled issues so no label edit or comment fires", async () => {
    const { deps, ghCalls } = makeDeps();

    const result = await runBoot(
      deps,
      options({
        operationalProbes: {
          remoteUrls: [],
          labelBodyCoherence: {
            // Second boot: the issue was already quarantined so it no longer has
            // ready-for-agent and the probe returns an empty list.
            listOpenReadyIssues: async () => [],
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(ghCalls.editLabels.filter((e) => e.issue === 1971)).toHaveLength(0);
    expect(ghCalls.comment.filter((c) => c.issue === 1971)).toHaveLength(0);
  });

  it("halts with BootHaltError when the quarantine label edit fails", async () => {
    const { deps } = makeDeps();
    const origEditLabels = deps.gh.editLabels;
    deps.gh.editLabels = async (issue, remove, add) => {
      if (issue === 1971) throw new Error("gh API error: 503");
      return origEditLabels(issue, remove, add);
    };

    await expect(runBoot(deps, coherenceOptions())).rejects.toBeInstanceOf(BootHaltError);
  });

  it("names the probe in the BootHaltError when quarantine fails", async () => {
    const { deps } = makeDeps();
    deps.gh.editLabels = async () => {
      throw new Error("gh API error");
    };

    await expect(runBoot(deps, coherenceOptions())).rejects.toMatchObject({
      phase: "operational-probe",
      probe: { id: "afk.label-body-coherence" },
    });
  });

  it("continues boot when comment posting fails but label edit succeeds", async () => {
    const { deps, ghCalls } = makeDeps();
    deps.gh.comment = async (issue, body) => {
      if (issue === 1971) throw new Error("comment API error");
    };

    const result = await runBoot(deps, coherenceOptions());

    expect(result.bootstrap).toEqual({ ok: true });
    const edit = ghCalls.editLabels.find((e) => e.issue === 1971);
    expect(edit?.remove).toContain("ready-for-agent");
    expect(edit?.add).toContain("needs-triage");
  });

  it("logs the quarantined issue and blocker summary at supervisor level", async () => {
    const log = vi.fn();
    const { deps } = makeDeps({ log });

    await runBoot(deps, coherenceOptions());

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("quarantined #1971"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ready-for-agent→needs-triage"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("kind=validation"));
  });

  it("quarantines multiple incoherent issues in one boot sweep", async () => {
    const { deps, ghCalls } = makeDeps();
    const issues = [
      { number: 100, title: "A", labels: ["ready-for-agent"], body: BLOCKER_BODY },
      { number: 200, title: "B", labels: ["ready-for-agent"], body: BLOCKER_BODY },
    ];

    const result = await runBoot(deps, coherenceOptions({ issues }));

    expect(result.bootstrap).toEqual({ ok: true });
    expect(ghCalls.editLabels.filter((e) => [100, 200].includes(e.issue))).toHaveLength(2);
  });

  it("comment body includes the issue number, labels, and blocker evidence", async () => {
    const { deps, ghCalls } = makeDeps();

    await runBoot(deps, coherenceOptions());

    const comment = ghCalls.comment.find((c) => c.issue === 1971);
    expect(comment?.body).toContain("<!-- afk:quarantine v1 issue=#1971 -->");
    expect(comment?.body).toContain("ready-for-agent");
    expect(comment?.body).toContain("Fix recipe");
  });
});
