import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DEV_APP = join(ROOT, "apps", "dev");
const DEV_BUNDLE = join(ROOT, "dist", "dev.bundle.min.mjs");
const REQUIRE_LITERAL = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
const builtinSpecifiers = new Set(
  builtinModules.flatMap((name) => {
    const bare = name.replace(/^node:/, "");
    return [bare, `node:${bare}`];
  }),
);

describe("dev bundle contract", () => {
  it(
    "does not leave third-party package requires in the generated bundle",
    () => {
      execFileSync("pnpm", ["run", "bundle"], {
        cwd: DEV_APP,
        env: {
          ...process.env,
          RED_BUILD_VERSION: "0.0.0-test",
          RED_BUILD_GIT_SHA: "test",
          RED_BUILD_TIME: "2026-01-01T00:00:00.000Z",
        },
        stdio: "pipe",
      });

      const bundle = readFileSync(DEV_BUNDLE, "utf8");
      const thirdPartyRequires = [...bundle.matchAll(REQUIRE_LITERAL)]
        .map((match) => match[2])
        .filter(isBarePackageSpecifier)
        .filter((specifier) => !builtinSpecifiers.has(specifier));

      expect(thirdPartyRequires).toEqual([]);
    },
    120_000,
  );
});

function isBarePackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:");
}
