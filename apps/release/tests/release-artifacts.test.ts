import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderReleaseArtifacts,
  writeReleaseArtifacts,
  type ReleaseArtifactInput,
} from "../src/release-artifacts.js";

const GOLDENS = join(import.meta.dirname, "fixtures", "release-artifacts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release notes and manifest artifacts", () => {
  it("pins human notes and JSON/TOON manifests for a representative queue", () => {
    const rendered = renderReleaseArtifacts(REPRESENTATIVE_RELEASE);

    expect(rendered.notes).toBe(golden("release-notes.md"));
    expect(rendered.json).toBe(golden("release-manifest.json"));
    expect(rendered.toon).toBe(golden("release-manifest.toon"));
  });

  it("keeps the JSON and TOON manifests structurally identical", () => {
    const rendered = renderReleaseArtifacts(REPRESENTATIVE_RELEASE);

    expect(decode(rendered.toon)).toEqual(JSON.parse(rendered.json));
    expect(decode(golden("release-manifest.toon"))).toEqual(
      JSON.parse(golden("release-manifest.json")),
    );
  });

  it("publishes all three artifacts together in a new directory", () => {
    const root = mkdtempSync(join(tmpdir(), "red-release-artifacts-"));
    temporaryDirectories.push(root);
    const outputDirectory = join(root, "release");

    expect(writeReleaseArtifacts({
      ...REPRESENTATIVE_RELEASE,
      outputDirectory,
    })).toEqual({
      directory: outputDirectory,
      notesPath: join(outputDirectory, "release-notes.md"),
      jsonManifestPath: join(outputDirectory, "release-manifest.json"),
      toonManifestPath: join(outputDirectory, "release-manifest.toon"),
    });
    expect(readFileSync(join(outputDirectory, "release-notes.md"), "utf8"))
      .toBe(golden("release-notes.md"));
    expect(readFileSync(join(outputDirectory, "release-manifest.json"), "utf8"))
      .toBe(golden("release-manifest.json"));
    expect(readFileSync(join(outputDirectory, "release-manifest.toon"), "utf8"))
      .toBe(golden("release-manifest.toon"));
  });
});

const REPRESENTATIVE_RELEASE: ReleaseArtifactInput = {
  version: "2.0.0",
  date: "2026-08-05",
  changes: [
    {
      file: "bright-dogs-smile.md",
      summary: "Correct version rendering for release candidates.",
      body: "Correct version rendering for release candidates.",
      impact: "patch",
      releases: [{ packageName: "@example/core", impact: "patch" }],
      authors: ["@sam"],
      pullRequests: [318],
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
      authors: ["@zoe", "@ada", "@ada"],
      pullRequests: [321, 319, 321],
    },
    {
      file: "quiet-bears-wave.md",
      summary: "Add a read-only release status command.",
      body: "Add a read-only release status command.",
      impact: "minor",
      releases: [{ packageName: "@example/cli", impact: "minor" }],
      authors: ["@lee"],
      pullRequests: [320],
    },
  ],
};

function golden(file: string): string {
  return readFileSync(join(GOLDENS, file), "utf8");
}
