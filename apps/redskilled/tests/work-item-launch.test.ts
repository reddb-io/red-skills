import { describe, expect, it } from "vitest";

import { planHostDemand } from "../src/demand-loop.js";
import { expandLaunchTemplate, REDSKILLED_LAUNCH_FACTS } from "../src/launch-template.js";

/**
 * A birth carries the item it is for.
 *
 * The poll keeps identifiers (#4098) and the launch is where they reach a
 * Worker: a template that names `{{work_item}}` is filled with the identifier
 * the planner chose for that birth, and a template that names it while the
 * birth has none fails closed — a Worker started with a blank where its work
 * should be is one nobody meant to start.
 */
const facts = {
  worker_id: "W1",
  slot: 0,
  workspace_path: "/tmp/w",
};

describe("a launch template can name the work item it was born for", () => {
  it("declares work_item among the facts a birth supplies", () => {
    expect(REDSKILLED_LAUNCH_FACTS).toContain("work_item");
  });

  it("writes the identifier into the argv", () => {
    const launch = expandLaunchTemplate(
      { argv: ["redskilled", "work", "--work-item", "{{work_item}}", "--worker", "{{worker_id}}"] },
      { ...facts, work_item: "4100" },
    );

    expect(launch.argv).toEqual(["redskilled", "work", "--work-item", "4100", "--worker", "W1"]);
  });

  it("fails closed when a template names it and the birth has none", () => {
    expect(() =>
      expandLaunchTemplate({ argv: ["redskilled", "work", "--work-item", "{{work_item}}"] }, facts),
    ).toThrow(/work_item/);
    expect(() =>
      expandLaunchTemplate({ argv: ["redskilled", "work", "--work-item", "{{work_item}}"] }, {
        ...facts,
        work_item: "",
      }),
    ).toThrow(/work_item/);
  });

  it("leaves a template that never names it untouched", () => {
    expect(expandLaunchTemplate({ argv: ["redskilled", "acp-worker"] }, facts).argv)
      .toEqual(["redskilled", "acp-worker"]);
  });

  it("hands two births in one tick two different items", () => {
    const plan = planHostDemand({
      projects: [{
        project_label: "a/b",
        selector: "is:issue",
        argv: ["redskilled", "work", "--work-item", "{{work_item}}"],
        workspace_path: "/tmp/w",
        target: 2,
        items: ["11", "12", "13"],
      }],
      queue: { "a/b": 3 },
      live: {},
      nowMs: 0,
    });

    expect(plan.births.map((birth) => birth.work_item)).toEqual(["11", "12"]);
  });

  it("skips as many items as the project already has Workers", () => {
    const plan = planHostDemand({
      projects: [{
        project_label: "a/b",
        selector: "is:issue",
        argv: ["redskilled", "work"],
        workspace_path: "/tmp/w",
        target: 3,
        items: ["11", "12", "13"],
      }],
      queue: { "a/b": 3 },
      live: { "a/b": 2 },
      nowMs: 0,
    });

    expect(plan.births.map((birth) => birth.work_item)).toEqual(["13"]);
  });

  it("plans a birth with no item when the poll kept none — the claim still decides", () => {
    const plan = planHostDemand({
      projects: [{
        project_label: "a/b",
        selector: "is:issue",
        argv: ["redskilled", "work"],
        workspace_path: "/tmp/w",
        target: 1,
      }],
      queue: { "a/b": 5 },
      live: {},
      nowMs: 0,
    });

    expect(plan.births).toHaveLength(1);
    expect(plan.births[0]).not.toHaveProperty("work_item");
  });
});
