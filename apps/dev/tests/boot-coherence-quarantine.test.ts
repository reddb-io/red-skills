import { runCastleWorkerDrain } from "@reddb-io/red-castle/engine";
import { describe, expect, it, vi } from "vitest";
import { makeDeps, options, runBoot } from "./boot.helpers.js";

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

interface MutableIssue {
  number: number;
  title: string;
  labels: string[];
  body: string;
}

function poisonedIssue(): MutableIssue {
  return {
    number: 1971,
    title: "Poisoned work item",
    labels: ["ready-for-agent", "ready-for-human", "priority:normal"],
    body: BLOCKER_BODY,
  };
}

function healthyIssue(): MutableIssue {
  return {
    number: 1972,
    title: "Healthy sibling",
    labels: ["ready-for-agent", "priority:normal"],
    body: "## Agent brief\n\nShip the healthy slice.",
  };
}

function coherenceOptions(issues: MutableIssue[]) {
  return options({
    operationalProbes: {
      remoteUrls: [],
      labelBodyCoherence: {
        listOpenReadyIssues: async () => issues.filter((issue) => issue.labels.includes("ready-for-agent")),
      },
    },
  });
}

function wireIssueMutations(
  deps: ReturnType<typeof makeDeps>["deps"],
  issues: MutableIssue[],
  overrides: { failLabels?: boolean; failQuarantineAddAfterRemove?: boolean; failBody?: boolean } = {},
) {
  const editLabels = vi.fn(async (number: number, remove: string[], add: string[]) => {
    if (overrides.failLabels) throw new Error("label mutation failed");
    const issue = issues.find((candidate) => candidate.number === number)!;
    issue.labels = issue.labels.filter((label) => !remove.includes(label));
    if (overrides.failQuarantineAddAfterRemove && add.includes("quarantine")) {
      throw new Error("quarantine label missing");
    }
    issue.labels.push(...add.filter((label) => !issue.labels.includes(label)));
  });
  const editBody = vi.fn(async (number: number, body: string) => {
    if (overrides.failBody) throw new Error("body mutation failed");
    issues.find((candidate) => candidate.number === number)!.body = body;
  });
  deps.gh.editLabels = editLabels;
  Object.assign(deps.gh, {
    editBody,
    // The transition API reads live labels before planning (#2528).
    viewLabels: async (number: number) =>
      issues.find((candidate) => candidate.number === number)?.labels ?? [],
  });
  return { editLabels, editBody };
}

async function drainAfterBoot(
  deps: ReturnType<typeof makeDeps>["deps"],
  issues: MutableIssue[],
) {
  const processed: number[] = [];
  const result = await runCastleWorkerDrain(
    {
      gh: {
        listCandidates: async () => issues.filter((issue) => issue.labels.includes("ready-for-agent")),
      },
      runBoot,
      bootDeps: deps,
      bootOptions: coherenceOptions(issues),
      processIssue: async (_processDeps: object, input: { issue: number; runner: "codex" }) => {
        processed.push(input.issue);
        return { outcome: "done" as const };
      },
      processDeps: {},
      buildProcessInput: (issue) => ({ issue: issue.number, runner: "codex" as const }),
      emit: () => undefined,
    },
    {
      runner: "codex",
      workerId: "wTEST",
      filter: { kind: "all" },
      issueTemplate: {},
    },
  );
  return { processed, result };
}

describe("ADR 0122 boot quarantine posture", () => {
  it("quarantines one incoherent issue and claims its healthy sibling in the same boot", async () => {
    const issues = [poisonedIssue(), healthyIssue()];
    const { deps } = makeDeps();
    const mutations = wireIssueMutations(deps, issues);

    const { processed, result } = await drainAfterBoot(deps, issues);

    expect(result.boot.bootstrap).toEqual({ ok: true });
    expect(processed).toEqual([1972]);
    // #2528: the transition API cures the WHOLE poison shape in one atomic edit —
    // the stacked ready-for-human role leaves together with ready-for-agent.
    expect(mutations.editLabels).toHaveBeenCalledWith(
      1971,
      ["ready-for-agent", "ready-for-human"],
      ["quarantine"],
    );
    expect(issues[0]?.labels).toContain("quarantine");
    expect(issues[0]?.labels).not.toContain("ready-for-agent");
    expect(issues[0]?.body).toContain("<!-- afk:quarantine v1 issue=#1971 -->");
    expect(issues[0]?.body).toContain("ready-for-human");
    expect(issues[0]?.body).toContain("kind=validation");
  });

  it.each(["labels", "body"] as const)(
    "does not globally halt or dispatch the poisoned issue when its %s mutation fails",
    async (failure) => {
      const issues = [poisonedIssue(), healthyIssue()];
      const { deps } = makeDeps();
      wireIssueMutations(deps, issues, {
        failLabels: failure === "labels",
        failBody: failure === "body",
      });

      const { processed, result } = await drainAfterBoot(deps, issues);

      expect(result.boot.bootstrap).toEqual({ ok: true });
      expect(result.boot.quarantinedIssues).toEqual([1971]);
      expect(processed).toEqual([1972]);
    },
  );

  it("restores ready-for-agent when the tracker removes queue labels before rejecting quarantine", async () => {
    const issues = [poisonedIssue(), healthyIssue()];
    const { deps } = makeDeps();
    const ensureLabel = vi.fn(async () => undefined);
    Object.assign(deps.gh, { ensureLabel });
    wireIssueMutations(deps, issues, { failQuarantineAddAfterRemove: true });

    const { processed, result } = await drainAfterBoot(deps, issues);

    expect(result.boot.bootstrap).toEqual({ ok: true });
    expect(processed).toEqual([1972]);
    expect(ensureLabel).toHaveBeenCalledWith("quarantine");
    expect(issues[0]?.labels).toContain("ready-for-agent");
  });

  it("is idempotent after the issue has left the executable queue", async () => {
    const issues = [poisonedIssue()];
    const { deps } = makeDeps();
    const mutations = wireIssueMutations(deps, issues);

    await runBoot(deps, coherenceOptions(issues));
    await runBoot(deps, coherenceOptions(issues));

    expect(mutations.editLabels).toHaveBeenCalledTimes(1);
    expect(mutations.editBody).toHaveBeenCalledTimes(1);
  });
});
