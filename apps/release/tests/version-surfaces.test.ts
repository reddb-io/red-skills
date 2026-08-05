import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeVersionSurfaces } from "../src/version-surfaces.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("version surfaces", () => {
  it("writes every confirmed npm, Cargo, and exotic surface byte-for-byte", () => {
    const root = workspaceFixture();

    expect(writeVersionSurfaces({ repoRoot: root, nextVersion: "2.0.0" })).toEqual({
      version: "2.0.0",
      written: [
        "Cargo.toml",
        "VERSION.txt",
        "crates/engine/Cargo.toml",
        "package.json",
        "packages/cli/package.json",
      ],
      syncCommandRan: false,
    });

    expect(read(root, "package.json")).toBe(`{
  "name": "fixture-root",
  "version": "2.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ]
}\n`);
    expect(read(root, "packages/cli/package.json")).toBe(`{
  "name": "@fixture/cli",
  "version": "2.0.0"
}\n`);
    expect(read(root, "Cargo.toml")).toBe(`[workspace]
members = ["crates/*"]

[workspace.package]
version = "2.0.0"
`);
    expect(read(root, "crates/engine/Cargo.toml")).toBe(`[package]
name = "fixture-engine"
version = "2.0.0"
`);
    expect(read(root, "VERSION.txt")).toBe("2.0.0\n");
  });

  it("refuses workspace drift and names the orphan package before writing", () => {
    const root = workspaceFixture();
    write(root, "packages/orphan/package.json", `{
  "name": "@fixture/orphan",
  "version": "1.2.3"
}\n`);

    expect(() => writeVersionSurfaces({ repoRoot: root, nextVersion: "2.0.0" }))
      .toThrow("@fixture/orphan (packages/orphan/package.json)");
    expect(read(root, "package.json")).toContain('"version": "1.2.3"');
  });

  it("runs the optional repo-owned sync command with the next version", () => {
    const root = workspaceFixture({ syncCommand: "node scripts/sync-version.mjs" });
    write(root, "scripts/sync-version.mjs", `
import { writeFileSync } from "node:fs";
writeFileSync("synced-version.txt", process.env.RED_RELEASE_VERSION + "\\n");
`);

    expect(writeVersionSurfaces({ repoRoot: root, nextVersion: "2.0.0" }).syncCommandRan)
      .toBe(true);
    expect(read(root, "synced-version.txt")).toBe("2.0.0\n");
  });

  it("writes confirmed npm surfaces outside the derived workspace", () => {
    const root = workspaceFixture();
    write(root, "plugins/example/plugin.json", `{
  "name": "example-plugin",
  "version": "1.2.3"
}\n`);
    const configPath = join(root, ".red/config.yaml");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}    - path: plugins/example/plugin.json\n      format: npm\n`,
    );

    expect(() => writeVersionSurfaces({ repoRoot: root, nextVersion: "2.0.0" }))
      .not.toThrow();
    expect(read(root, "plugins/example/plugin.json")).toContain('"version": "2.0.0"');
  });
});

function workspaceFixture(options: { syncCommand?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "red-release-surfaces-"));
  temporaryDirectories.push(root);
  write(root, "package.json", `{
  "name": "fixture-root",
  "version": "1.2.3",
  "private": true,
  "workspaces": [
    "packages/*"
  ]
}\n`);
  write(root, "packages/cli/package.json", `{
  "name": "@fixture/cli",
  "version": "1.2.3"
}\n`);
  write(root, "Cargo.toml", `[workspace]
members = ["crates/*"]

[workspace.package]
version = "1.2.3"
`);
  write(root, "crates/engine/Cargo.toml", `[package]
name = "fixture-engine"
version = "1.2.3"
`);
  write(root, "VERSION.txt", "1.2.3\n");
  const syncCommand = options.syncCommand === undefined
    ? ""
    : `\n  sync_command: ${JSON.stringify(options.syncCommand)}`;
  write(root, ".red/config.yaml", `release:
  scheme: semver
  trigger: version-pr
  version_surfaces:
    - path: package.json
      format: npm
    - path: packages/cli/package.json
      format: npm
    - path: Cargo.toml
      format: cargo
    - path: crates/engine/Cargo.toml
      format: cargo
    - path: VERSION.txt
      format: text${syncCommand}
`);
  return root;
}

function write(root: string, path: string, source: string): void {
  const absolutePath = join(root, path);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, source);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}
