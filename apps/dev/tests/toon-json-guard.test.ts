import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectToonJsonGuardReport,
  collectToonJsonIoFindingsFromFiles,
  formatToonJsonGuardViolations,
  type ToonJsonAllowlistEntry,
} from "../src/core/toon-json-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DEV_SRC = join(import.meta.dirname, "..", "src");

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

  it("mints a line-independent id — a pure line shift keeps the allowlist entry valid", () => {
    const write = `writeFileSync(join(root, "state.json"), JSON.stringify({ ok: true }), "utf8");`;
    const near = `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nexport function persistState(root: string) {\n  ${write}\n}\n`;
    const shifted = `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n// an unrelated comment\n// and another line\n// and a third line above the site\nexport function persistState(root: string) {\n  ${write}\n}\n`;
    const [a] = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/state.ts", sourceText: near },
    ]);
    const [b] = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/example/src/state.ts", sourceText: shifted },
    ]);
    expect(a!.line).not.toBe(b!.line); // the statement genuinely moved
    expect(a!.id).toBe(b!.id); // ...but the snippet-anchored id is stable
  });

  it("stays test-only — no runtime src imports the guard or typescript (keeps the compiler out of the bundle)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.") || entry.name === "toon-json-guard.ts") continue;
        const text = readFileSync(p, "utf8");
        if (/from ["'][^"']*toon-json-guard(\.js)?["']/.test(text) || /from ["']typescript["']/.test(text)) {
          offenders.push(relative(ROOT, p));
        }
      }
    };
    walk(DEV_SRC);
    // The guard imports the full `typescript` compiler; if any other runtime src
    // imports the guard (or typescript directly) it lands in dev.bundle.min.mjs
    // — the regression the release contract check caught. Keep it test-only.
    expect(offenders).toEqual([]);
  });
});
