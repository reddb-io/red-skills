import { describe, expect, it } from "vitest";

import {
  buildDrainRegistration,
  DRAIN_WORKER_PROMPT,
} from "../src/core/drain-registration.js";

/**
 * The MCP authors the semantics; the daemon carries them.
 *
 * The registration a drain hands over is the piece nobody reconnected after
 * the dev CLI was deleted (#4031): every drain since recorded an intention the
 * demand loop had nothing to poll for.
 */
const input = {
  repo: "reddb-io/red-skills",
  workspacePath: "/home/op/src/red-skills",
  target: 2,
  version: "4.0.0",
  runner: "redcode",
};

describe("what a drain hands the daemon", () => {
  it("carries the tracker query and its typed poll plan together", () => {
    const registration = buildDrainRegistration(input);

    expect(registration.selector).toContain("reddb-io/red-skills");
    expect(registration.queue_poll).toMatchObject({ owner: "reddb-io", repo: "red-skills" });
    expect(registration.queue_poll.labels.length).toBeGreaterThan(0);
  });

  it("names a runnable argv in the canonical form, pinned to a version", () => {
    const registration = buildDrainRegistration(input);

    expect(registration.argv.slice(0, 4)).toEqual(["npx", "-y", "-p", "@reddb-io/red-skills@4.0.0"]);
    expect(registration.argv).toContain("acp-worker");
    expect(registration.argv).toContain("redcode");
  });

  it("tells the Worker to work the item the daemon fills in, and nothing more", () => {
    expect(buildDrainRegistration(input).prompt).toBe(DRAIN_WORKER_PROMPT);
    expect(DRAIN_WORKER_PROMPT).toContain("{{work_item}}");
    expect(DRAIN_WORKER_PROMPT).toContain("/afk");
    // #4162: the Worker's workspace is already materialised on the Ticket's
    // base; an inner agent told nothing builds a nested worktree by following
    // the repository's interactive-mode rules.
    expect(DRAIN_WORKER_PROMPT).toContain("never create another worktree");
  });

  it("narrows the queue by the facets a caller stated", () => {
    const narrowed = buildDrainRegistration({ ...input, selector: { label: "lane:go" } });

    expect(narrowed.selector).toContain("lane:go");
    expect(narrowed.queue_poll.labels).toContain("lane:go");
  });

  it("carries the width the caller asked for, and its own workspace", () => {
    const registration = buildDrainRegistration(input);

    expect(registration.target).toBe(2);
    expect(registration.workspace_path).toBe("/home/op/src/red-skills");
  });
});

describe("a registration that can actually drain", () => {
  it("states the trunk — the handoff refuses to exist without a base", () => {
    expect(buildDrainRegistration(input).trunk).toEqual({ remote: "origin", branch: "main" });
    expect(buildDrainRegistration({ ...input, trunkBranch: "develop" }).trunk)
      .toEqual({ remote: "origin", branch: "develop" });
  });
});
