/**
 * The extension has to be INSTALLABLE, and that is a delivery fact rather than a
 * source fact. This app was complete, tested and wired to the daemon while its
 * README said the `.vsix` is "never published" — so the only way to install it
 * was to clone the monorepo, `pnpm install` 19 packages and build it (issue
 * #3060). The maintainer reversed that: the archive is attached to every GitHub
 * Release. It still reaches no marketplace, which is a different statement and
 * the one the packager's refusal was always about.
 *
 * Two halves, failing for different reasons. The DECLARATIONS half asserts every
 * place the release keys off the artifact's name still names it — an archive
 * nothing builds is the same outage as one nothing attaches. The ARCHIVE half
 * asserts the bytes an editor is handed: a live editor is not testable here, so
 * what IS tested is everything `code --install-extension` reads before it runs
 * anything — the manifest, its version, and the files the manifest points at.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { packageVsix, vsixFileName } from "../src/package-vsix.js";
import { readZip } from "../src/packaging/vsix.js";

const EXTENSION_ROOT = join(import.meta.dirname, "..");
const REPO = join(EXTENSION_ROOT, "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "red-publish.yml");

// The packager collects `out/extension.cjs`, so the archive under test is the
// one this tree builds rather than one a previous run left behind.
beforeAll(() => {
  execFileSync("pnpm", ["run", "bundle"], { cwd: EXTENSION_ROOT, stdio: "pipe" });
}, 120_000);

/** The slice of `text` between two markers, so a match lands in the right step. */
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `workflow is missing ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from);
  expect(to, `workflow is missing ${end} after ${start}`).toBeGreaterThan(-1);
  return text.slice(from, to);
}

describe("the .vsix ships as a release asset", () => {
  it("is packaged, manifested and attached by the publish workflow", async () => {
    const workflow = await readFile(WORKFLOW, "utf8");
    // A packaging step, or the archive never exists at release time.
    expect(workflow).toContain("working-directory: apps/vscode-extension-red-skills");
    const manifestStep = section(workflow, "- name: Build release manifest", "- name: GitHub Release");
    expect(manifestStep).toContain("vscode-extension-red-skills-");
    const releaseStep = section(workflow, "assets=(", "dist/release-manifest.json");
    expect(releaseStep).toContain("vscode-extension-red-skills-");
  });

  it("names the asset the release publishes, version and all", () => {
    expect(vsixFileName("3.4.0")).toBe("vscode-extension-red-skills-3.4.0.vsix");
  });

  it("carries the release version in the archive, not only in the file name", async () => {
    const packaged = await packageVsix({ version: "v9.9.9" });

    expect(packaged.version).toBe("9.9.9");
    expect(packaged.outputPath.endsWith(vsixFileName("9.9.9"))).toBe(true);

    const entries = readZip(packaged.archive);
    const manifest = entries.find((entry) => entry.path === "extension/package.json");
    expect(manifest, "the archive ships no extension manifest").toBeDefined();
    // The editor keys "already installed" off THIS number. Stamping only the
    // file name would make every release after the first a download that
    // installs nothing.
    expect(JSON.parse(manifest!.contents.toString("utf8")).version).toBe("9.9.9");

    const vsixManifest = entries.find((entry) => entry.path === "extension.vsixmanifest");
    expect(vsixManifest!.contents.toString("utf8")).toContain('Version="9.9.9"');
  });

  it("ships every file the manifest points at, so an install has something to run", async () => {
    const packaged = await packageVsix();
    const paths = readZip(packaged.archive).map((entry) => entry.path);

    expect(paths).toContain("extension.vsixmanifest");
    expect(paths).toContain("[Content_Types].xml");
    const manifest = JSON.parse(await readFile(join(EXTENSION_ROOT, "package.json"), "utf8")) as {
      main: string;
    };
    expect(paths).toContain(`extension/${manifest.main.replace(/^\.\//, "")}`);
    expect(paths).toContain("extension/package.json");
    expect(paths).toContain("extension/README.md");
    expect(paths).toContain("extension/LICENSE.txt");
  });

  it("defaults to the checkout's own version when no release stamps one", async () => {
    const manifest = JSON.parse(await readFile(join(EXTENSION_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const packaged = await packageVsix();

    expect(packaged.version).toBe(manifest.version);
  });

  it("documents the install that needs no checkout", async () => {
    const readme = await readFile(join(EXTENSION_ROOT, "README.md"), "utf8");

    expect(readme).toContain("code --install-extension");
    expect(readme).toContain("codium --install-extension");
    expect(readme).toContain("gh release download");
    // The reversed claim, so the README cannot drift back to "never published"
    // while a release carries the file.
    expect(readme).not.toContain("never published");
  });
});
