import { describe, expect, test } from "vitest";
import {
  WATCHED_GLOBS,
  filterWatchedPaths,
  isWatchedPath,
} from "../src/watched-paths.js";

describe("watched-paths declarative list (AC2, AC3)", () => {
  test("the list covers every closed-loop memory surface", () => {
    // The declarative list is the single source of truth; assert it carries
    // exactly the ADR 0027 Amendment surfaces.
    expect([...WATCHED_GLOBS]).toEqual([
      ".red/adr/**/*.md",
      ".red/wiki/pages/**/*.md",
      ".red/CONTEXT.md",
      ".red/CONTEXT-MAP.md",
      ".red/contexts/**/*.md",
    ]);
  });

  test.each([
    ["/repo/.red/adr/0027-closed-loop.md", true],
    ["/repo/.red/adr/sub/nested/0001.md", true],
    ["/repo/.red/wiki/pages/memory.md", true],
    ["/repo/.red/wiki/pages/topic/sub.md", true],
    ["/repo/.red/CONTEXT.md", true],
    ["/repo/.red/CONTEXT-MAP.md", true],
    ["/repo/.red/contexts/afk.md", true],
    [".red/adr/0027.md", true],
    // Non-watched: ordinary source, sibling dirs, wrong extension, near-misses.
    ["/repo/src/widget.ts", false],
    ["/repo/.red/agents/memory.md", false],
    ["/repo/.red/adr/0027.txt", false],
    ["/repo/.red/CONTEXT.json", false],
    ["/repo/.red/CONTEXTXMAP.md", false],
    ["/repo/elsewhere/.red/notes/x.md", false],
  ])("isWatchedPath(%s) === %s", (path, expected) => {
    expect(isWatchedPath(path)).toBe(expected);
  });

  test("normalizes Windows-style separators", () => {
    expect(isWatchedPath("C:\\repo\\.red\\adr\\0027.md")).toBe(true);
  });

  test("filterWatchedPaths keeps only watched paths, preserving order", () => {
    expect(
      filterWatchedPaths([
        "/repo/src/a.ts",
        "/repo/.red/CONTEXT.md",
        "/repo/notes.txt",
        "/repo/.red/adr/0001.md",
      ]),
    ).toEqual(["/repo/.red/CONTEXT.md", "/repo/.red/adr/0001.md"]);
  });
});
