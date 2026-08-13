import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { githubCoveragePath, openGithubCoverageCache } from "./app-coverage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "app-coverage-"));
  roots.push(root);
  return root;
}

describe("the learned coverage answer", () => {
  it("remembers an answer for the processes that come after", () => {
    const path = githubCoveragePath(tempRoot(), "153309957");
    openGithubCoverageCache(path).remember("reddb-io", "red-skills", true);

    const reopened = openGithubCoverageCache(path);
    expect(reopened.covered("reddb-io", "red-skills")).toBe(true);
    // Repository names are case-insensitive on GitHub; the cache must agree.
    expect(reopened.covered("RedDB-IO", "RED-SKILLS")).toBe(true);
    expect(reopened.covered("vitest-dev", "vitest")).toBeUndefined();
  });

  it("forgets an answer older than its horizon, because installations change", () => {
    const path = githubCoveragePath(tempRoot(), "1");
    const day = 24 * 60 * 60 * 1000;
    openGithubCoverageCache(path, day, () => 0).remember("reddb-io", "red-skills", false);

    expect(openGithubCoverageCache(path, day, () => day / 2).covered("reddb-io", "red-skills")).toBe(false);
    expect(openGithubCoverageCache(path, day, () => day * 2).covered("reddb-io", "red-skills")).toBeUndefined();
  });

  it("treats an unreadable cache as an empty one — a saved request is never an outage", () => {
    const path = join(tempRoot(), "corrupt.toon");
    writeFileSync(path, " not a document");
    expect(openGithubCoverageCache(path).covered("reddb-io", "red-skills")).toBeUndefined();
  });
});
