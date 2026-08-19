import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditFileSizes,
  FILE_SIZE_BASELINE,
  FILE_SIZE_THRESHOLD,
} from "../src/core/file-size-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["apps", "packages"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "dist-bundle", "generated", ".turbo"]);

/** Every non-test TypeScript source under apps/ and packages/, by line count. */
function measureTree(): Map<string, number> {
  const measured = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      const rel = relative(ROOT, path).split(sep).join("/");
      // Counted the way `wc -l` counts, so a baseline number means the same
      // thing to the ratchet and to the person reading the file.
      const text = readFileSync(path, "utf8");
      measured.set(rel, text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(ROOT, root));
  return measured;
}

describe("file-size ratchet — a split nothing enforces is a split that comes back", () => {
  it("holds the live tree to the threshold and the shrink-only baseline", () => {
    const findings = auditFileSizes(measureTree());
    const rendered = findings.map((f) => `  - ${f.reason}`).join("\n");
    expect(
      findings,
      findings.length === 0
        ? ""
        : `file-size ratchet: ${findings.length} finding(s).\n${rendered}\n` +
          `Baseline: apps/plugin-dev/src/core/file-size-guard.ts (FILE_SIZE_BASELINE); shrink only.`,
    ).toEqual([]);
  });

  it("refuses a NEW file over the threshold", () => {
    const findings = auditFileSizes(new Map([["apps/plugin-dev/src/invented.ts", FILE_SIZE_THRESHOLD + 1]]));
    expect(findings[0]?.kind).toBe("over-threshold");
    expect(findings[0]?.reason).toContain("Split it by domain");
  });

  it("refuses a baselined file that GREW, naming both numbers", () => {
    const findings = auditFileSizes(new Map([["a.ts", 1200]]), [{ path: "a.ts", lines: 1000 }]);
    expect(findings[0]?.kind).toBe("over-baseline");
    expect(findings[0]?.reason).toContain("grew from 1000 to 1200");
  });

  it("accepts a baselined file that shrank but is still over the threshold", () => {
    expect(auditFileSizes(new Map([["a.ts", 900]]), [{ path: "a.ts", lines: 1000 }])).toEqual([]);
  });

  it("demands a baseline entry be DROPPED once its file passes under", () => {
    // An inventory nobody prunes is one nobody trusts: a stale entry silently
    // re-authorises the growth the shrink just paid for.
    const findings = auditFileSizes(new Map([["a.ts", 400]]), [{ path: "a.ts", lines: 1000 }]);
    expect(findings[0]?.kind).toBe("stale-baseline");
  });

  it("says nothing about a baselined file that is gone", () => {
    expect(auditFileSizes(new Map(), [{ path: "deleted.ts", lines: 1000 }])).toEqual([]);
  });

  it("keeps the decomposed MCP surface out of the baseline entirely", () => {
    // handlers.ts was the forcing function and it paid: 2070 lines became six
    // domain modules, none of which needs an entry. A file that decomposes
    // leaves no debt behind.
    const baselined = new Set(FILE_SIZE_BASELINE.map((entry) => entry.path));
    for (const path of ["handlers", "project", "vitals", "queue", "events", "dependencies"]) {
      expect(baselined.has(`apps/plugin-dev/src/mcp/${path}.ts`), `${path} must not be baselined`).toBe(false);
    }
  });
});
