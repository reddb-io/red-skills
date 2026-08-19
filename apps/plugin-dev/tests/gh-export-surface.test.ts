import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeDir = join(process.cwd(), "src", "runtime");

const EXPECTED_GH_EXPORTS = [
  "CandidateListDiagnostics",
  "CommentTrustResolver",
  "DependencyEdgeTicketRow",
  "DependencyEdgeTicketScan",
  "GhContext",
  "IssueStateRow",
  "StatuslineQueueCounts",
  "actorTrustSignals",
  "attachSubIssue",
  "blockerState",
  "closeIssue",
  "comment",
  "countNeedsInfo",
  "countNeedsTriage",
  "countOpenIssues",
  "countOpenPrs",
  "countPrsCreatedToday",
  "countReadyForAgent",
  "countReadyForHuman",
  "countStatuslineQueueCounts",
  "countUnlabeled",
  "crashedClaimState",
  "createActorTrustLookup",
  "createIssue",
  "editBody",
  "editComment",
  "editLabels",
  "ensureLabel",
  "ensureRunnerErrorLabel",
  "externalApprovalActors",
  "ghAuthenticated",
  "ghInstalled",
  "issueAuthor",
  "issueBody",
  "issueClosed",
  "issueComments",
  "issueMeta",
  "issueReference",
  "issueTrust",
  "issueUrl",
  "listByLabel",
  "listCandidates",
  "listClaimComments",
  "listDependencyEdgeTickets",
  "listHitlCandidates",
  "listIssueStates",
  "listLabelNames",
  "listOpenPullRequests",
  "listParkedMechanicalCandidates",
  "listSpecSubIssueCandidates",
  "listUnblockCandidates",
  "orphanState",
  "postClaimComment",
  "queueVisibilityProbeInput",
  "readIssueBody",
  "readIssueComments",
  "repoVisibility",
  "resolveDispatchCandidatePool",
  "resolveDispatchCandidates",
  "resolveSelectorUser",
  "resolveViewerLogin",
  "viewIssueFull",
  "viewLabels",
].sort();

function lineCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").length;
}

function collectExportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s+interface\s+(\w+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s+type\s+(\w+)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/\s+as\s+\w+$/, "");
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

describe("runtime gh module shape", () => {
  it("keeps gh.ts as a small barrel with the same public names", () => {
    const source = readFileSync(join(runtimeDir, "gh.ts"), "utf8");
    expect(lineCount(join(runtimeDir, "gh.ts"))).toBeLessThanOrEqual(1200);
    expect(collectExportedNames(source)).toEqual(EXPECTED_GH_EXPORTS);
  });

  it("keeps split gh modules below the line budget", () => {
    const ghDir = join(runtimeDir, "gh");
    for (const entry of readdirSync(ghDir)) {
      const path = join(ghDir, entry);
      if (!entry.endsWith(".ts") || !statSync(path).isFile()) continue;
      expect(lineCount(path), entry).toBeLessThanOrEqual(1200);
    }
  });
});
