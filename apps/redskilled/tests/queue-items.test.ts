import { describe, expect, it } from "vitest";

import {
  carryQueueItems,
  queueItemIdentifiers,
  REDSKILLED_QUEUE_ITEM_CAP,
  type RedskilledQueueDiscovery,
} from "../src/queue-discovery.js";

/**
 * A poll that counts and then discards has to be asked again.
 *
 * The REST lane already holds every item it counted; throwing the identifiers
 * away left a birth with a depth and nothing to hand a Worker (Spec #4097).
 */
const discovery = (
  projects: RedskilledQueueDiscovery["projects"],
): RedskilledQueueDiscovery => ({
  version: 1,
  fetched_at: "2026-08-19T20:00:00.000Z",
  request_count: 1,
  project_count: projects.length,
  batch_size: 1,
  rate_limit: { remaining: null, reset_at: null, exhausted: false },
  projects,
});

describe("the queue poll keeps the identifiers it counted", () => {
  it("takes the identifiers a REST answer listed, as opaque strings", () => {
    expect(queueItemIdentifiers([{ number: 12 }, { number: 7 }])).toEqual(["12", "7"]);
  });

  it("skips an item the transport returned without one, rather than inventing a name", () => {
    expect(queueItemIdentifiers([{ number: 12 }, {}, { number: 0 }, { number: 1.5 }, { number: 9 }]))
      .toEqual(["12", "9"]);
  });

  it("bounds the list so a record cannot grow with the backlog", () => {
    const many = Array.from({ length: REDSKILLED_QUEUE_ITEM_CAP + 20 }, (_, index) => ({ number: index + 1 }));

    expect(queueItemIdentifiers(many)).toHaveLength(REDSKILLED_QUEUE_ITEM_CAP);
  });

  it("carries the last list across a poll that could not list — an unreachable queue is not an empty one", () => {
    const previous = discovery([
      { project_label: "a/b", outcome: "counted", depth: 2, detail: "counted", items: ["4", "5"] },
    ]);
    const failed = discovery([
      { project_label: "a/b", outcome: "unreachable", depth: null, detail: "the queue fetch failed" },
    ]);

    expect(carryQueueItems(failed, previous).projects[0]).toMatchObject({
      outcome: "unreachable",
      items: ["4", "5"],
    });
  });

  it("lets a counted poll replace the list, including with an empty one", () => {
    const previous = discovery([
      { project_label: "a/b", outcome: "counted", depth: 2, detail: "counted", items: ["4", "5"] },
    ]);
    const drained = discovery([
      { project_label: "a/b", outcome: "counted", depth: 0, detail: "counted", items: [] },
    ]);

    expect(carryQueueItems(drained, previous).projects[0]?.items).toEqual([]);
  });

  it("carries nothing for a project the previous poll did not cover", () => {
    const failed = discovery([
      { project_label: "c/d", outcome: "unreachable", depth: null, detail: "the queue fetch failed" },
    ]);

    expect(carryQueueItems(failed, discovery([])).projects[0]).not.toHaveProperty("items");
  });
});
