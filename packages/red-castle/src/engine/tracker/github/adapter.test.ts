import { describe, expect, it } from "vitest";
import { createGitHubTrackerAdapter, type GhExec } from "./adapter.js";

describe("GitHub tracker adapter", () => {
  it("quarantines tracker IO behind gh CLI calls", async () => {
    const calls: string[][] = [];
    const gh: GhExec = async (args) => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          { number: 12, body: "Body", labels: [{ name: "wait:dependency" }, { name: "depends-on:7" }] },
        ]);
      }
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ state: "CLOSED", number: 7, title: "Base", url: "https://example.invalid/7" });
      }
      return "";
    };

    const tracker = createGitHubTrackerAdapter({ gh, repo: "owner/repo" });

    await expect(tracker.listOpenIssuesByLabel("wait:dependency")).resolves.toEqual([
      { number: 12, body: "Body", labels: ["wait:dependency", "depends-on:7"] },
    ]);
    await expect(tracker.isIssueClosed(7)).resolves.toBe(true);
    await tracker.editIssueLabels(12, { remove: ["wait:dependency"], add: ["queue:agent"] });
    await tracker.commentOnIssue(12, "done");

    expect(calls).toEqual([
      ["issue", "list", "--state", "open", "--label", "wait:dependency", "--json", "number,body,labels", "--limit", "1000", "--repo", "owner/repo"],
      ["issue", "view", "7", "--json", "state", "--repo", "owner/repo"],
      ["issue", "edit", "12", "--remove-label", "wait:dependency", "--add-label", "queue:agent", "--repo", "owner/repo"],
      ["issue", "comment", "12", "--body", "done", "--repo", "owner/repo"],
    ]);
  });
});
