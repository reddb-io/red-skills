// A registration carries a query the TRACKER can answer (#2974).
//
// The daemon hands the selector to GitHub verbatim, so a selector in the
// project's own JSON shape asked for issues matching the literal text `{}` — a
// question with an answer of nothing, on every project, forever. These pin the
// shape the daemon can act on, and the facets the query cannot carry.
import { describe, expect, it } from "vitest";
import {
  buildRegistrationPollPlan,
  buildRegistrationQuery,
  registrationQueryUnexpressedFacets,
} from "../src/core/registration-query.js";

describe("the query a registration hands the host", () => {
  it("counts this repository's executable queue when no facet narrows it", () => {
    expect(buildRegistrationQuery({ repo: "acme/widgets" })).toBe(
      'repo:acme/widgets is:issue is:open label:"ready-for-agent"',
    );
  });

  it("never encodes the project's own selector shape", () => {
    // The defect itself: `{}` is not a question the tracker can answer, and the
    // count it comes back with is not a fact about this project's backlog.
    expect(buildRegistrationQuery({ repo: "acme/widgets", selector: {} })).not.toContain("{}");
  });

  it("narrows by lane, label, tags and author, keeping tags an AND", () => {
    const query = buildRegistrationQuery({
      repo: "acme/widgets",
      selector: { lane: "go", label: "type:ticket", tags: ["alpha", "beta"], user: "octocat" },
    });

    expect(query).toBe(
      'repo:acme/widgets is:issue is:open label:"ready-for-agent" label:"lane:go" label:"type:ticket" ' +
        'label:"tag:alpha" label:"tag:beta" author:octocat',
    );
  });

  it("describes the equivalent conditional REST list without asking the daemon to parse the query", () => {
    expect(buildRegistrationPollPlan({
      repo: "acme/widgets",
      selector: { lane: "go", label: "type:ticket", tags: ["alpha", "beta"], user: "octocat" },
    })).toEqual({
      owner: "acme",
      repo: "widgets",
      labels: ["ready-for-agent", "lane:go", "type:ticket", "tag:alpha", "tag:beta"],
      creator: "octocat",
      counter_labels: { ready: "ready-for-agent", human: "ready-for-human" },
    });
  });

  it("leaves an unresolved `@me` out rather than searching for the literal", () => {
    // `@me` is concretized before a registration is made; if one slips through,
    // an unnarrowed count beats a query that matches nothing at all.
    expect(buildRegistrationQuery({ repo: "acme/widgets", selector: { user: "@me" } })).not.toContain("author:");
  });

  it("refuses a registration with no repository to count in", () => {
    // A query without `repo:` counts every repository the host token can see,
    // which would birth Workers for another project's backlog entirely.
    expect(() => buildRegistrationQuery({ repo: "  " })).toThrow(/repository its queue lives in/);
  });

  it("names the facets a tracker query cannot express, instead of hiding them", () => {
    expect(registrationQueryUnexpressedFacets({ spec: 12, issues: [1, 2] })).toEqual(["spec", "issues"]);
    expect(registrationQueryUnexpressedFacets({ lane: "go" })).toEqual([]);
    expect(registrationQueryUnexpressedFacets(undefined)).toEqual([]);
  });
});
