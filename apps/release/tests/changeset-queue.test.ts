import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChangesetParseError,
  readChangesetQueue,
} from "../src/changeset-queue.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "changesets");

describe("changeset queue", () => {
  it("pins a single changeset", () => {
    expect(readChangesetQueue(join(FIXTURES, "single"))).toEqual({
      changes: [
        {
          file: "quiet-bears-wave.md",
          summary: "Add a read-only release status command.",
          body: "Add a read-only release status command.",
          impact: "minor",
          releases: [{ packageName: "@example/cli", impact: "minor" }],
        },
      ],
      pending: { major: 0, minor: 1, patch: 0 },
    });
  });

  it("sorts multiple changesets and classifies each by its highest package impact", () => {
    expect(readChangesetQueue(join(FIXTURES, "multiple"))).toEqual({
      changes: [
        {
          file: "bright-dogs-smile.md",
          summary: "Correct version rendering for release candidates.",
          body: "Correct version rendering for release candidates.",
          impact: "patch",
          releases: [{ packageName: "@example/core", impact: "patch" }],
        },
        {
          file: "calm-cats-dance.md",
          summary: "Replace the legacy release API.",
          body: "Replace the legacy release API.\n\nThe new API keeps every package on one version train.",
          impact: "major",
          releases: [
            { packageName: "@example/cli", impact: "minor" },
            { packageName: "@example/core", impact: "major" },
          ],
        },
      ],
      pending: { major: 1, minor: 0, patch: 1 },
    });
  });

  it("returns an empty queue as data", () => {
    expect(readChangesetQueue(join(FIXTURES, "empty"))).toEqual({
      changes: [],
      pending: { major: 0, minor: 0, patch: 0 },
    });
  });

  it("fails loudly with the malformed filename", () => {
    expect(() => readChangesetQueue(join(FIXTURES, "malformed"))).toThrowError(
      expect.objectContaining({
        name: ChangesetParseError.name,
        message: expect.stringContaining("broken-entry.md"),
      }),
    );
  });
});
