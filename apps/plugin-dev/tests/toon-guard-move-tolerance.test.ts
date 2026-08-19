import { describe, expect, it } from "vitest";
import {
  collectToonJsonIoFindingsFromFiles,
  formatToonJsonGuardViolations,
  type ToonJsonAllowlistEntry,
  type ToonJsonIoFinding,
} from "../src/core/toon-json-guard.js";

// A file-split relocates a JSON I/O site to a new file: same kind + snippet
// (behavior-preserving) but a new path, so the snippet+path-anchored id changes.
// The guard must recognize the move via the path-independent moveKey instead of
// redding, WITHOUT laundering a genuinely-new stack-owned JSON site.

const READ_SNIPPET = `import { readFileSync } from "node:fs";
export function load(p: string) {
  const raw = readFileSync(p, "utf8");
  return JSON.parse(raw);
}
`;

function findingIn(relativePath: string): ToonJsonIoFinding {
  const [finding] = collectToonJsonIoFindingsFromFiles([{ relativePath, sourceText: READ_SNIPPET }]);
  if (!finding) throw new Error("expected a json-parse-file-read finding");
  return finding;
}

describe("toon guard — move tolerance", () => {
  it("tolerates a relocated external site (stale external entry absorbs the moved finding by moveKey)", () => {
    const moved = findingIn("apps/x/src/bench-eval/loaders.ts");
    // The site's pre-split entry: same kind+snippet -> same moveKey, a DIFFERENT
    // (now stale) id because the old path is gone.
    const stale: ToonJsonAllowlistEntry = {
      id: "apps/x/src/bench-eval.ts#json-parse-file-read#deadbeef1234",
      classification: "external",
      reason: "external bench data read",
      moveKey: moved.moveKey,
    };
    expect(formatToonJsonGuardViolations({ findings: [moved], allowlist: [stale] })).toEqual([]);
  });

  it("flags a genuinely-new site (no stale external entry with a matching moveKey)", () => {
    const fresh = findingIn("apps/x/src/new.ts");
    const violations = formatToonJsonGuardViolations({ findings: [fresh], allowlist: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("unallowlisted");
  });

  it("consumes a stale external moveKey at most once (a second same-snippet site still reds)", () => {
    const a = findingIn("apps/x/src/a.ts");
    const b = findingIn("apps/x/src/b.ts"); // identical snippet -> same moveKey, different id
    const stale: ToonJsonAllowlistEntry = {
      id: "apps/x/src/gone.ts#json-parse-file-read#cafef00d5678",
      classification: "external",
      reason: "external data read",
      moveKey: a.moveKey,
    };
    const violations = formatToonJsonGuardViolations({ findings: [a, b], allowlist: [stale] });
    expect(violations).toHaveLength(1); // one relocation absorbed, one still unallowlisted
    expect(violations[0]).toContain("unallowlisted");
  });

  it("does not offer a stale MIGRATE entry as relocatable (only external absorbs moves)", () => {
    const moved = findingIn("apps/x/src/loaders.ts");
    const staleMigrate: ToonJsonAllowlistEntry = {
      id: "apps/x/src/index.ts#json-parse-file-read#0000abcd1111",
      classification: "migrate",
      moveKey: moved.moveKey,
    };
    const violations = formatToonJsonGuardViolations({ findings: [moved], allowlist: [staleMigrate] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("unallowlisted");
  });

  it("does not flag a stale entry itself as a violation (removed/moved sites are harmless)", () => {
    const stale: ToonJsonAllowlistEntry = {
      id: "apps/x/src/removed.ts#json-parse-file-read#feedface9999",
      classification: "external",
      reason: "external data read",
      moveKey: "orphan000000",
    };
    expect(formatToonJsonGuardViolations({ findings: [], allowlist: [stale] })).toEqual([]);
  });
});
