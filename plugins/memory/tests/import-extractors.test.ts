import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  extractImportsForFile,
  typescriptJavascriptImportExtractor,
} from "../src/import-extractors.js";

describe("typescriptJavascriptImportExtractor", () => {
  test("extracts relative and bare import specifiers", () => {
    const imports = typescriptJavascriptImportExtractor(
      null,
      `
        import React from "react";
        import { issueToken } from "./auth";
      `,
    );

    expect(imports).toEqual([
      { specifier: "react", kind: "bare" },
      { specifier: "./auth", kind: "relative" },
    ]);
  });

  test("extracts multiline, namespace, named, default, and re-export forms", () => {
    const imports = typescriptJavascriptImportExtractor(
      null,
      `
        import DefaultThing from "./default";
        import * as namespaceThing from "namespace-lib";
        import {
          alpha,
          beta,
        } from "../named";
        export { gamma } from "./re-export";
        export * from "bare-re-export";
      `,
    );

    expect(imports).toEqual([
      { specifier: "./default", kind: "relative" },
      { specifier: "namespace-lib", kind: "bare" },
      { specifier: "../named", kind: "relative" },
      { specifier: "./re-export", kind: "relative" },
      { specifier: "bare-re-export", kind: "bare" },
    ]);
  });
});

describe("extractImportsForFile", () => {
  test("dispatches the TypeScript/JavaScript extractor for tsx, js, and jsx files", () => {
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      expect(
        extractImportsForFile(join("/repo", `entry${ext}`), null, `import value from "pkg";`),
      ).toEqual([{ specifier: "pkg", kind: "bare" }]);
    }
  });

  test("resolves relative import specifiers against the source file directory", () => {
    const sourcePath = join("/repo", "src", "ui", "view.tsx");
    const imports = extractImportsForFile(
      sourcePath,
      null,
      `
        import React from "react";
        import { issueToken } from "../auth";
      `,
    );

    expect(imports).toEqual([
      { specifier: "react", kind: "bare" },
      {
        specifier: "../auth",
        kind: "relative",
        resolvedPath: join("/repo", "src", "auth"),
      },
    ]);
  });
});
