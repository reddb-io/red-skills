import { describe, expect, it } from "vitest";

import { drainRegistrationFor, repositoryOf } from "../src/core/drain-registration-resolve.js";
import { DRAIN_WORKER_PROMPT } from "../src/core/drain-registration.js";

/**
 * A drain that carries no work registers nothing.
 *
 * The daemon births only for a registration, and the checkout is the one thing
 * that knows what this project's work IS. This is the seam that asks the
 * machine; the builder it calls stays pure.
 */
describe("the registration a checkout's drain carries", () => {
  it("names the repository, the workspace and the version a birth reaches for", () => {
    const registration = drainRegistrationFor(
      "/home/op/src/red-skills",
      "4.0.1",
      { target: 2, runner: "redcode" },
      () => ({ name: "reddb-io/red-skills" }) as never,
    );

    expect(registration).toMatchObject({
      workspace_path: "/home/op/src/red-skills",
      target: 2,
      prompt: DRAIN_WORKER_PROMPT,
    });
    expect(registration?.argv).toContain("@reddb-io/red-skills@4.0.1");
    expect(registration?.argv).toContain("redcode");
  });

  it("falls back to the default width when the caller states none", () => {
    expect(drainRegistrationFor("/home/op/src/red-skills", "4.0.1", {}, () => ({ name: "a/b" }) as never)?.target)
      .toBe(1);
  });

  it("says nothing for a checkout that cannot name a repository", () => {
    // Absent is a real answer: inventing an owner would register a project the
    // daemon then polls for nothing.
    expect(repositoryOf("/tmp/scratch", () => ({ name: "scratch" }) as never)).toBeUndefined();
    expect(repositoryOf("/tmp/scratch", () => { throw new Error("not a checkout"); })).toBeUndefined();
  });

  it("accepts the owner/name a checkout does state", () => {
    expect(repositoryOf("/x", () => ({ name: "reddb-io/red-skills" }) as never)).toBe("reddb-io/red-skills");
  });
});
