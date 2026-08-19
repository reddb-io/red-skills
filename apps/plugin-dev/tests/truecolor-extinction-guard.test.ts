import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  BRAND_TOKEN_DERIVATION_MODULES,
  collectTruecolorExtinctionFindings,
  collectTruecolorExtinctionFindingsFromFiles,
  formatTruecolorExtinctionFailure,
  readPaintedSurfaceSourceFiles,
} from "../src/core/truecolor-extinction-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("literal truecolor escapes stay extinct on painted surfaces (ADR 0137)", () => {
  it("passes on the live painted-surface source trees", () => {
    const findings = collectTruecolorExtinctionFindings(ROOT);

    expect(findings, formatTruecolorExtinctionFailure(findings)).toEqual([]);
  });

  it("scans every painted application instead of passing over an empty walk", () => {
    const paths = readPaintedSurfaceSourceFiles(ROOT).map((file) => file.relativePath);

    expect(paths).toEqual(expect.arrayContaining([
      "apps/plugin-dev/src/core/statusline.ts",
      "apps/vscode-extension-redskilled/src/views/dashboard-panel.ts",
      "apps/herdr-plugin-redskilled/src/ui/ansi.mjs",
      "packages/redskilled-render/palette.ts",
    ]));
  });

  it("skips a swept package's vendored node_modules", () => {
    const paths = readPaintedSurfaceSourceFiles(ROOT).map((file) => file.relativePath);

    expect(paths.some((path) => path.includes("/node_modules/"))).toBe(false);
  });

  it("fails with the file and line of a hand-tuned escape", () => {
    const findings = collectTruecolorExtinctionFindingsFromFiles([
      {
        relativePath: "apps/plugin-dev/src/core/statusline-hotfix.ts",
        sourceText: [
          'export const reset = "\\u001b[0m";',
          'export const hotfix = "\\u001b[38;2;17;34;51m";',
        ].join("\n"),
      },
    ]);

    expect(findings).toMatchObject([
      {
        relativePath: "apps/plugin-dev/src/core/statusline-hotfix.ts",
        line: 2,
        layer: "foreground",
      },
    ]);
    expect(formatTruecolorExtinctionFailure(findings)).toContain(
      "apps/plugin-dev/src/core/statusline-hotfix.ts:2",
    );
  });

  it("exempts only the brand package's derivation module", () => {
    const literal = 'export const paint = "\\u001b[48;2;17;34;51m";';

    expect(collectTruecolorExtinctionFindingsFromFiles([
      { relativePath: BRAND_TOKEN_DERIVATION_MODULES[0]!, sourceText: literal },
    ])).toEqual([]);
    expect(collectTruecolorExtinctionFindingsFromFiles([
      { relativePath: `${BRAND_TOKEN_DERIVATION_MODULES[0]!}.copy`, sourceText: literal },
    ])).toMatchObject([{ layer: "background", line: 1 }]);
  });

  it("runs in every gate as a declared repo invariant", () => {
    expect(REPO_INVARIANT_SUITES).toContainEqual(expect.objectContaining({
      name: "invariants:truecolor-extinction",
      scope: "apps/plugin-dev",
      script: "test:invariants",
    }));
  });
});
