import { describe, expect, it } from "vitest";
import {
  buildAliasedLabelMutation,
  buildAliasedRepositoryQuery,
  buildAliasedSubIssueMutation,
  parseAliasedRepositoryResponse,
} from "./github-batch.js";

describe("GitHub aliased batch GraphQL core", () => {
  it("builds one ordered repository query and isolates an alias error", () => {
    const operation = buildAliasedRepositoryQuery("issue", [42, 7, 99], ["title", "state", "labels", "body"]);

    expect(operation.aliases).toEqual([
      { alias: "i0", number: 42 },
      { alias: "i1", number: 7 },
      { alias: "i2", number: 99 },
    ]);
    expect(operation.query).toContain("i0: issue(number: 42)");
    expect(operation.query).toContain("i1: issue(number: 7)");
    expect(operation.query).toContain("i2: issue(number: 99)");

    const rows = parseAliasedRepositoryResponse(operation, {
      data: {
        repository: {
          i0: { number: 42, title: "first" },
          i1: { number: 7, title: "second" },
          i2: null,
        },
      },
      errors: [{ message: "Could not resolve issue 99", path: ["repository", "i2"] }],
    });

    expect(rows).toEqual([
      { number: 42, value: { number: 42, title: "first" } },
      { number: 7, value: { number: 7, title: "second" } },
      { number: 99, error: "Could not resolve issue 99" },
    ]);
  });

  it("builds all label edits and sub-issue links as aliased single mutations", () => {
    const labels = buildAliasedLabelMutation(
      [{ number: 7, nodeId: "I_7" }, { number: 8, nodeId: "I_8" }],
      ["L_add"],
      ["L_remove"],
    );
    expect(labels.aliases).toEqual([
      { alias: "add0", number: 7 },
      { alias: "remove0", number: 7 },
      { alias: "add1", number: 8 },
      { alias: "remove1", number: 8 },
    ]);
    expect(labels.query.match(/mutation RspEditLabels/g)).toHaveLength(1);
    expect(labels.query).toContain("addLabelsToLabelable");
    expect(labels.query).toContain("removeLabelsFromLabelable");

    const links = buildAliasedSubIssueMutation(
      { number: 42, nodeId: "I_parent" },
      [{ number: 7, nodeId: "I_7" }, { number: 8, nodeId: "I_8" }],
    );
    expect(links.aliases).toEqual([
      { alias: "link0", number: 7 },
      { alias: "link1", number: 8 },
    ]);
    expect(links.query.match(/addSubIssue/g)).toHaveLength(2);
  });
});
