import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const RELEASE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(RELEASE_ROOT, "..", "..");
const VENDORED = join(REPO_ROOT, ".github", "red-skills", "release.bundle.mjs");
const REFRESH = "pnpm -C apps/release build && cp dist/release.bundle.min.mjs .github/red-skills/release.bundle.mjs";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The vendored engine is a BUILD ARTIFACT committed into the tree, and a build
 * artifact nothing rebuilds is a copy of whatever the source used to say.
 *
 * `release.execution: vendored` makes the release workflow run this file rather
 * than a published npm version, which is what lets a release fix apply without
 * first being published. That inverts into its own trap: two fixes to the engine
 * landed on main, the workflow ran the frozen bundle, and the release train
 * reproduced both bugs from source that no longer contained them (#3466). The
 * source read correct, the tests passed, and the thing that ran was neither.
 */
/**
 * Drop the wall-clock stamp esbuild bakes in, so the comparison is about CODE.
 *
 * Every build writes its own `__RED_BUILD_TIME__`, which is the one byte range
 * that legitimately differs between two builds of identical source. Comparing
 * with it in place would fail on every run and teach the reader to ignore this
 * test — which is worse than not having it.
 */
function withoutBuildStamp(source: string): string {
  return source.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<build-time>");
}

describe("vendored release engine (#3466)", () => {
  it("is a build of the engine source in this tree", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "red-release-vendor-"));
    temporary.push(outputDirectory);
    const rebuilt = join(outputDirectory, "release.bundle.mjs");

    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "bundle-app.mjs"),
        "--entry", "src/cli.ts",
        "--outfile", rebuilt,
        // The asset name is stamped INTO the bundle, so it must match the name
        // the vendored copy was built under or the bytes differ for that alone.
        "--asset", "release.bundle.min.mjs",
        "--minify",
      ],
      {
        cwd: RELEASE_ROOT,
        stdio: "pipe",
        // bundle-app shells out to `esbuild`, which lives in the workspace bin
        // directory rather than on an inherited PATH.
        env: { ...process.env, PATH: `${join(REPO_ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}` },
      },
    );

    // Compared as a boolean, not with `toBe`: these are 300KB of minified code,
    // and a character diff of that is noise. What the reader needs is the
    // command that fixes it.
    const matches = withoutBuildStamp(readFileSync(rebuilt, "utf8")) ===
      withoutBuildStamp(readFileSync(VENDORED, "utf8"));
    expect(
      matches,
      `.github/red-skills/release.bundle.mjs is not a build of apps/release/src.\n` +
        `The release workflow runs the VENDORED file, so an engine fix that stops here never runs.\n` +
        `Refresh it with:\n  ${REFRESH}`,
    ).toBe(true);
  }, 60_000);

  it("answers --version without a working machine, as every shipped binary must", () => {
    const answer = execFileSync(process.execPath, [VENDORED, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(answer.trim().split(/\s+/)[0]).toBe("red-skills-release");
  });
});
