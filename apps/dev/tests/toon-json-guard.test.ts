import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectToonJsonGuardReport,
  collectToonJsonIoFindingsFromFiles,
  formatToonJsonGuardViolations,
  type ToonJsonAllowlistEntry,
} from "../src/core/toon-json-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("toon JSON file I/O guard", () => {
  it("ratchets the live apps/packages JSON file I/O allowlist", async () => {
    const report = await collectToonJsonGuardReport(ROOT);

    expect(formatToonJsonGuardViolations(report)).toEqual([]);
  });

  it("rejects a new stack-owned JSON.stringify file write until allowlisted", () => {
    const source = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";

      export function persistState(root: string) {
        writeFileSync(join(root, "state.json"), JSON.stringify({ ok: true }), "utf8");
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/state.ts", sourceText: source },
    ]);
    expect(findings).toHaveLength(1);

    expect(formatToonJsonGuardViolations({ findings, allowlist: [] })).toEqual([
      expect.stringContaining(findings[0]!.id),
    ]);

    const allowlist: ToonJsonAllowlistEntry[] = [
      {
        id: findings[0]!.id,
        classification: "migrate",
      },
    ];

    expect(formatToonJsonGuardViolations({ findings, allowlist })).toEqual([]);
  });
});
