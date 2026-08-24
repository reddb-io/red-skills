import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  drainInputFor,
  drainRegistrationFor,
  repositoryOf,
} from "../src/core/drain-registration-resolve.js";
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

/**
 * The declared standing runner reaches the registration (#4293).
 *
 * `drainRegistrationFor` used to take the runner from the tool call alone, so a
 * `drain` with no runner argument composed an argv with no `--child-agent` and
 * admission fell back to the governed default — while the repository's own
 * config declared an executor.
 */
describe("what a drain that states nothing resolves", () => {
  const identity = () => ({ name: "reddb-io/design-system" }) as never;

  function checkout(standing: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "drain-standing-"));
    mkdirSync(join(root, ".red"), { recursive: true });
    writeFileSync(
      join(root, ".red", "config.yaml"),
      `plugins:\n  dev:\n    enabled: true\n${standing ?? ""}`,
      "utf8",
    );
    return root;
  }

  const DECLARED = "    afk:\n      standing:\n        runner: claude-code\n        target: 3\n";

  it("carries the declared runner and target when the caller states neither", () => {
    const input = drainInputFor(checkout(DECLARED), "4.0.1", {}, identity);

    expect(input.runner).toBe("claude-code");
    expect(input.target).toBe(3);
    const registration = input.registration as { argv: readonly string[]; target: number };
    expect(registration.argv).toEqual(expect.arrayContaining(["--child-agent", "claude-code"]));
    expect(registration.target).toBe(3);
  });

  it("lets an explicitly stated runner and target win over the declaration", () => {
    const input = drainInputFor(checkout(DECLARED), "4.0.1", { runner: "codex", target: 1 }, identity);

    expect(input.runner).toBe("codex");
    expect(input.target).toBe(1);
    expect((input.registration as { argv: readonly string[] }).argv)
      .toEqual(expect.arrayContaining(["--child-agent", "codex"]));
  });

  it("leaves a repo that declared nothing exactly as it was", () => {
    const input = drainInputFor(checkout(null), "4.0.1", {}, identity);

    expect(input).not.toHaveProperty("runner");
    expect(input.target).toBe(1);
    expect((input.registration as { argv: readonly string[] }).argv).not.toContain("--child-agent");
  });

  it("a drain completed from afk.standing carries standing intent to the daemon", () => {
    const input = drainInputFor(checkout(DECLARED), "4.0.1", {}, identity);

    expect((input.registration as { standing?: boolean }).standing).toBe(true);
  });

  it("an explicit drain in a repo that declares afk.standing also registers standing", () => {
    // The declaration IS the standing intent: the repo said its drain should
    // survive daemon restarts, and the daemon restarts on every self-upgrade.
    const input = drainInputFor(checkout(DECLARED), "4.0.1", { runner: "codex", target: 1 }, identity);

    expect((input.registration as { standing?: boolean }).standing).toBe(true);
  });

  it("a drain in a repo with no standing declaration carries none", () => {
    const input = drainInputFor(checkout(null), "4.0.1", {}, identity);

    expect(input.registration).not.toHaveProperty("standing");
  });

  it("keeps an incomplete declaration inert — it registers the governed default, not a guess", () => {
    const input = drainInputFor(
      checkout("    afk:\n      standing:\n        runner: claude-code\n"),
      "4.0.1",
      {},
      identity,
    );

    expect(input).not.toHaveProperty("runner");
    expect(input.target).toBe(1);
  });
});
