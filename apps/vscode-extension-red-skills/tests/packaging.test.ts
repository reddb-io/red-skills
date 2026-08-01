import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip, readZip, renderContentTypes, renderVsixManifest } from "../src/packaging/vsix.js";

const EXTENSION_ROOT = join(import.meta.dirname, "..");

describe("the .vsix archive", () => {
  it("round-trips every entry it writes, deflated or stored", () => {
    const entries = [
      { path: "tiny.txt", contents: Buffer.from("no", "utf8") },
      { path: "extension/big.txt", contents: Buffer.from("compress me ".repeat(500), "utf8") },
      { path: "extension/binary.bin", contents: Buffer.from([0, 1, 2, 250, 251]) },
    ];

    const read = readZip(buildZip(entries, new Date("1980-01-01T00:00:00Z")));
    expect(read.map((entry) => entry.path)).toEqual(entries.map((entry) => entry.path));
    for (const [index, entry] of entries.entries()) {
      expect(read[index]!.contents.equals(entry.contents)).toBe(true);
    }
  });

  it("is byte-identical across two builds of one tree", () => {
    const entries = [{ path: "extension/package.json", contents: Buffer.from('{"a":1}', "utf8") }];
    const first = buildZip(entries, new Date("1980-01-01T00:00:00Z"));
    const second = buildZip(entries, new Date("1980-01-01T00:00:00Z"));
    expect(first.equals(second)).toBe(true);
  });

  it("escapes the manifest, so a description with an ampersand still parses", () => {
    const xml = renderVsixManifest({
      publisher: "reddb-io",
      name: "vscode-extension-red-skills",
      version: "0.1.0",
      displayName: "RedSkills & redskilled",
      description: 'Workers, logs & "events"',
      engineVersion: "^1.75.0",
      categories: ["Other"],
    });

    expect(xml).toContain('Id="vscode-extension-red-skills"');
    expect(xml).toContain('Publisher="reddb-io"');
    expect(xml).toContain("RedSkills &amp; redskilled");
    expect(xml).toContain("&quot;events&quot;");
    expect(xml).not.toMatch(/&(?!amp;|quot;|apos;|lt;|gt;)/);
  });

  it("declares a content type for every suffix it is handed", () => {
    const xml = renderContentTypes(["vsixmanifest", "json", "cjs", "md", "txt", "svg", "weird"]);
    for (const extension of ["vsixmanifest", "json", "cjs", "md", "txt", "svg"]) {
      expect(xml).toContain(`Extension="${extension}"`);
    }
    expect(xml).toContain('Extension="weird" ContentType="application/octet-stream"');
  });
});

describe("the extension manifest", () => {
  it("is private and names no publish step — this .vsix never reaches a marketplace", async () => {
    const manifest = JSON.parse(await readFile(join(EXTENSION_ROOT, "package.json"), "utf8")) as {
      private: boolean;
      scripts: Record<string, string>;
      bin?: unknown;
      main: string;
      contributes: { views: Record<string, { id: string }[]>; commands: { command: string }[] };
    };

    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.scripts)).not.toContain("publish");
    expect(Object.values(manifest.scripts).join(" ")).not.toContain("vsce publish");
    // No `bin`: a shipped binary inherits the --version/--help obligations, and
    // an extension has no command line to answer them on.
    expect(manifest.bin).toBeUndefined();
    expect(manifest.main).toBe("./out/extension.cjs");
  });

  it("contributes the three views and the five read-only commands", async () => {
    const manifest = JSON.parse(await readFile(join(EXTENSION_ROOT, "package.json"), "utf8")) as {
      contributes: { views: Record<string, { id: string }[]>; commands: { command: string }[] };
    };

    expect(manifest.contributes.views.redskilled!.map((view) => view.id)).toEqual([
      "redskilled.workers",
      "redskilled.events",
      "redskilled.pullRequests",
    ]);
    expect(manifest.contributes.commands.map((command) => command.command).sort()).toEqual([
      "redskilled.copyWorkerId",
      "redskilled.refresh",
      "redskilled.revealWorkspace",
      "redskilled.showDashboard",
      "redskilled.showWorkerLog",
    ]);
  });

  it("excludes from the package exactly what the packager does not ship", async () => {
    const ignore = await readFile(join(EXTENSION_ROOT, ".vscodeignore"), "utf8");
    const packager = await readFile(join(EXTENSION_ROOT, "src", "package-vsix.ts"), "utf8");

    for (const excluded of ["src/", "tests/", "node_modules/"]) {
      expect(ignore).toContain(excluded);
      expect(packager).not.toContain(`target: "extension/${excluded}`);
    }
  });
});
