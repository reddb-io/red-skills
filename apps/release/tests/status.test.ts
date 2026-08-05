import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { readChangesetQueue } from "../src/changeset-queue.js";
import { computeReleaseStatus } from "../src/status.js";
import type { ReleaseClock } from "../src/version-core.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "changesets");
const CLOCK: ReleaseClock = { today: () => ({ year: 2026, month: 8 }) };

describe("release status", () => {
  it("pins the status verb output with the next version and every impact class", () => {
    let output = "";
    expect(
      main(
        [
          "status",
          "--changeset-dir",
          join(FIXTURES, "multiple"),
          "--current-version",
          "1.2.3",
          "--scheme",
          "semver",
        ],
        { clock: CLOCK, write: (text) => { output += text; } },
      ),
    ).toBe(0);

    expect(output).toMatchInlineSnapshot(`
      "Release status
      Current version: 1.2.3
      Next version: 2.0.0
      Pending changes: 2
      Changes:
        - patch: bright-dogs-smile.md — Correct version rendering for release candidates. [@example/core]
        - major: calm-cats-dance.md — Replace the legacy release API. [@example/cli, @example/core]
      "
    `);
  });

  it("pins an empty queue as a distinct successful no-release outcome", () => {
    const status = computeReleaseStatus({
      queue: readChangesetQueue(join(FIXTURES, "empty")),
      currentVersion: "1.2.3",
      scheme: "semver",
      clock: CLOCK,
    });

    expect(status).toEqual({
      outcome: "no-release",
      currentVersion: "1.2.3",
      changes: [],
    });
  });

  it("renders no release without treating it as an error", () => {
    let output = "";
    expect(
      main(
        ["status", "--changeset-dir", join(FIXTURES, "empty"), "--current-version", "1.2.3"],
        { clock: CLOCK, write: (text) => { output += text; } },
      ),
    ).toBe(0);
    expect(output).toMatchInlineSnapshot(`
      "Release status
      Current version: 1.2.3
      Outcome: no release
      Pending changes: 0
      "
    `);
  });
});
