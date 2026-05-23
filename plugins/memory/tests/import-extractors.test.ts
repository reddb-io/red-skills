import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  extractImportsForFile,
  rustImportExtractor,
  typescriptJavascriptImportExtractor,
} from "../src/import-extractors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUST_IMPORT_FIXTURE = join(HERE, "fixtures/rust-imports/src/features/session.rs");

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

  test("dispatches the Rust extractor and resolves crate, self, and super paths", () => {
    const sourcePath = join("/repo", "src", "features", "session.rs");
    const imports = extractImportsForFile(
      sourcePath,
      null,
      `
        use crate::auth::Token;
        use self::models::Session;
        use super::prelude::*;
        use std::fmt::Debug;
      `,
    );

    expect(imports).toEqual([
      {
        specifier: "crate::auth::Token",
        kind: "relative",
        resolvedPath: join("/repo", "src", "auth", "Token"),
      },
      {
        specifier: "self::models::Session",
        kind: "relative",
        resolvedPath: join("/repo", "src", "features", "models", "Session"),
      },
      {
        specifier: "super::prelude::*",
        kind: "relative",
        resolvedPath: join("/repo", "src", "prelude", "*"),
      },
      { specifier: "std::fmt::Debug", kind: "bare" },
    ]);
  });
});

describe("rustImportExtractor", () => {
  test("extracts simple, grouped, nested, renamed, glob, pub use, and extern crate forms", () => {
    const imports = rustImportExtractor(
      null,
      `
        use std::collections::HashMap;
        use crate::auth::{Session, TokenStore as Store};
        use self::models::{User, profile::{Avatar, Bio}};
        use super::prelude::*;
        pub use anyhow::Result;
        extern crate serde_json as json;
      `,
    );

    expect(imports).toEqual([
      { specifier: "std::collections::HashMap", kind: "bare" },
      { specifier: "crate::auth::Session", kind: "relative" },
      { specifier: "crate::auth::TokenStore", kind: "relative" },
      { specifier: "self::models::User", kind: "relative" },
      { specifier: "self::models::profile::Avatar", kind: "relative" },
      { specifier: "self::models::profile::Bio", kind: "relative" },
      { specifier: "super::prelude::*", kind: "relative" },
      { specifier: "anyhow::Result", kind: "bare" },
      { specifier: "serde_json", kind: "bare" },
    ]);
  });

  test("extracts the Rust fixture imports as Import values", async () => {
    const source = await readFile(RUST_IMPORT_FIXTURE, "utf8");

    expect(rustImportExtractor(null, source)).toEqual([
      { specifier: "std::collections::HashMap", kind: "bare" },
      { specifier: "crate::auth::Session", kind: "relative" },
      { specifier: "crate::auth::TokenStore", kind: "relative" },
      { specifier: "self::models::User", kind: "relative" },
      { specifier: "self::models::profile::Avatar", kind: "relative" },
      { specifier: "self::models::profile::Bio", kind: "relative" },
      { specifier: "super::prelude::*", kind: "relative" },
      { specifier: "anyhow::Result", kind: "bare" },
      { specifier: "serde_json", kind: "bare" },
    ]);
  });
});
