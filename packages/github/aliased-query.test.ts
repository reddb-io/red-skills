// One aliased query spans every registered repository (ADR 0130, built here).
import { describe, expect, it } from "vitest";
import { buildActivityCountsQuery, readActivityCounts } from "./aliased-query.js";

const REPOS = [
  { owner: "reddb-io", name: "red-skills" },
  { owner: "reddb-io", name: "reddb" },
];

describe("buildActivityCountsQuery", () => {
  it("returns null for no repositories — asking for nothing still costs a request", () => {
    expect(buildActivityCountsQuery([])).toBeNull();
  });

  it("puts every repository in ONE query", () => {
    const q = buildActivityCountsQuery(REPOS)!;
    expect(q.repoCount).toBe(2);
    expect(q.query.match(/repository\(/g)).toHaveLength(2);
    expect(q.query.startsWith("query ")).toBe(true);
  });

  it("aliases by index, so two owners may share a repository name", () => {
    const q = buildActivityCountsQuery([
      { owner: "a", name: "same" },
      { owner: "b", name: "same" },
    ])!;
    expect(Object.keys(q.aliases)).toEqual(["r0", "r1"]);
    expect(q.aliases.r0!.owner).toBe("a");
    expect(q.aliases.r1!.owner).toBe("b");
  });

  it("quotes owner and name rather than interpolating them raw", () => {
    const q = buildActivityCountsQuery([{ owner: 'a"b', name: "c" }])!;
    expect(q.query).toContain('"a\\"b"');
  });

  it("asks for counts and nothing else — a count is an integer the daemon stores", () => {
    const q = buildActivityCountsQuery(REPOS)!;
    expect(q.query).toContain("totalCount");
    expect(q.query).not.toContain("title");
    expect(q.query).not.toContain("labels");
  });
});

describe("readActivityCounts", () => {
  const q = buildActivityCountsQuery(REPOS)!;

  it("reads each alias back to its repository", () => {
    const out = readActivityCounts(q, {
      data: {
        r0: { issues: { totalCount: 12 }, pullRequests: { totalCount: 3 } },
        r1: { issues: { totalCount: 5 }, pullRequests: { totalCount: 1 } },
      },
    });
    expect(out).toEqual([
      { owner: "reddb-io", name: "red-skills", openIssues: 12, openPullRequests: 3 },
      { owner: "reddb-io", name: "reddb", openIssues: 5, openPullRequests: 1 },
    ]);
  });

  it("accepts the payload with or without the data envelope", () => {
    const bare = { r0: { issues: { totalCount: 1 }, pullRequests: { totalCount: 0 } } };
    expect(readActivityCounts(q, bare)).toHaveLength(1);
  });

  it("OMITS a repository that did not answer — absent, never zero", () => {
    // A repo renamed, made private, or unreachable by this token returns null.
    // Rendering that as 0 reports a healthy empty queue for something nobody
    // can see — the same distinction queue discovery draws already.
    const out = readActivityCounts(q, {
      data: { r0: null, r1: { issues: { totalCount: 5 }, pullRequests: { totalCount: 1 } } },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("reddb");
  });

  it("omits a node whose counts are not numbers", () => {
    const out = readActivityCounts(q, { data: { r0: { issues: {}, pullRequests: { totalCount: 1 } } } });
    expect(out).toHaveLength(0);
  });

  it("is empty for a malformed payload rather than throwing", () => {
    for (const bad of [null, undefined, "x", 3]) expect(readActivityCounts(q, bad)).toEqual([]);
  });
});
